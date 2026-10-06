/**
 * The Code Explainer page: a static shell, its stylesheet and the script that draws the model.
 *
 * The page owns only presentation state — zoom, pan, where a person dragged a card, what is
 * selected, which filters are on — and keeps it in the webview state so a hidden panel comes back
 * as it was left. Everything it shows comes from the model the host posts; every action it asks
 * for names a model id and a symbol id, which the host resolves against its own model. The page
 * never sends a path, a command or a URL to act on.
 *
 * Built with createElement and textContent only: source text, names and paths are inert.
 */
import { escape, icon } from './webview.ts';

export const CX_STYLE = `
  body:has(#cx-root) { max-width: none; padding: 0; margin: 0; overflow: hidden; }
  body:has(#cx-root) > .page-nav { margin: 0; padding: .35rem 1rem; border-top: 1px solid var(--sf-border-color); }
  #cx-root {
    --cx-changed: var(--sf-accent, #3d8e10); --cx-caller: #4f8fd8; --cx-callee: #a578e0; --cx-test: #d4a72c;
    --cx-external: #7d8c83; --cx-other: #8b978f; --cx-focus: #2bb3a3; --cx-repository: #7fa3c4;
    --cx-added: #3fb950; --cx-modified: #d29922; --cx-removed: #f85149;
    --cx-card: var(--sf-surface, var(--vscode-editorWidget-background)); --cx-card-head: var(--sf-surface-raised, var(--vscode-editorWidget-background));
    --cx-line: var(--sf-border-color, var(--vscode-panel-border)); --cx-line-strong: var(--sf-border-strong, var(--vscode-panel-border));
    --cx-dim: var(--sf-dim, var(--vscode-descriptionForeground)); --cx-faint: var(--sf-faint, var(--vscode-disabledForeground));
    --cx-text: var(--sf-text, var(--vscode-foreground)); --cx-mono: var(--sf-font-mono, var(--vscode-editor-font-family, monospace));
    --cx-edge: color-mix(in srgb, var(--cx-text) 30%, transparent); --cx-grid: color-mix(in srgb, var(--cx-text) 9%, transparent);
    --cx-inspector-w: 380px; --cx-outline-w: 250px;
    display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; height: calc(100vh - var(--cx-footer, 38px));
    color: var(--cx-text); background: var(--sf-bg, var(--vscode-editor-background)); font-size: 13px; min-width: 0;
  }
  body.vscode-light #cx-root { --cx-caller: #2f6fbf; --cx-callee: #7a4fc0; --cx-test: #9a6700; --cx-added: #1a7f37; --cx-modified: #9a6700; --cx-removed: #cf222e; --cx-focus: #12877a; --cx-repository: #46698a; }
  body.vscode-high-contrast #cx-root { --cx-edge: var(--vscode-contrastBorder, CanvasText); --cx-grid: transparent; }
  #cx-root *, #cx-root *::before, #cx-root *::after { box-sizing: border-box; }
  #cx-root button { min-height: 0; padding: 0; margin: 0; border: 0; background: none; color: inherit; font: inherit; font-weight: inherit;
    letter-spacing: normal; border-radius: 0; box-shadow: none; transform: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: flex-start; }
  #cx-root button:hover:not(:disabled), #cx-root button:active:not(:disabled) { background: none; box-shadow: none; transform: none; }
  #cx-root button:focus-visible, #cx-root [tabindex]:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--cx-changed)); outline-offset: 1px; }
  #cx-root .cx-btn { gap: .4rem; height: 28px; padding: 0 .7rem; border: 1px solid var(--cx-line-strong); border-radius: 4px; font-family: var(--cx-mono);
    font-size: 11.5px; letter-spacing: .02em; color: var(--cx-text); background: var(--cx-card); white-space: nowrap; }
  #cx-root .cx-btn:hover:not(:disabled) { border-color: var(--cx-changed); background: color-mix(in srgb, var(--cx-changed) 12%, var(--cx-card)); }
  #cx-root .cx-btn.cx-primary { background: var(--cx-changed); color: var(--sf-on-accent, #031005); border-color: var(--cx-changed); font-weight: 650; }
  #cx-root .cx-btn.cx-primary:hover:not(:disabled) { background: var(--sf-accent-hover, var(--cx-changed)); }
  #cx-root .cx-btn:disabled { opacity: .45; cursor: default; }
  #cx-root .cx-btn .ico, #cx-root .cx-icon-btn .ico { margin: 0; }
  #cx-root .cx-icon-btn { width: 28px; height: 28px; justify-content: center; border: 1px solid var(--cx-line-strong); border-radius: 4px; background: var(--cx-card); }
  #cx-root .cx-icon-btn:hover:not(:disabled) { border-color: var(--cx-changed); }
  #cx-root .cx-icon-btn[aria-pressed="true"] { border-color: var(--cx-changed); color: var(--cx-changed); }
  #cx-root code, #cx-root .mono { font-family: var(--cx-mono); }
  #cx-root [hidden] { display: none !important; }

  .cx-head { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem .6rem; border-bottom: 1px solid var(--cx-line); min-width: 0; }
  .cx-logo { flex: none; display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid var(--cx-line-strong); border-radius: 6px; color: var(--cx-changed); background: var(--cx-card); }
  .cx-heading { min-width: 0; flex: 1 1 auto; }
  .cx-heading h1 { display: flex; align-items: center; flex-wrap: wrap; gap: .45rem; margin: 0; font-size: 15px; font-weight: 650; letter-spacing: .01em; }
  .cx-chip { display: inline-flex; align-items: center; gap: .3rem; height: 19px; padding: 0 .45rem; border: 1px solid currentColor; border-radius: 3px;
    font-family: var(--cx-mono); font-size: 10px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
  .cx-chip.ok { color: var(--cx-changed); } .cx-chip.info { color: var(--cx-caller); } .cx-chip.warn { color: var(--cx-modified); } .cx-chip.bad { color: var(--cx-removed); } .cx-chip.dim { color: var(--cx-dim); }
  .cx-context { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .9rem; margin: .3rem 0 0; color: var(--cx-dim); font-family: var(--cx-mono); font-size: 11.5px; }
  .cx-context span { display: inline-flex; align-items: center; gap: .3rem; white-space: nowrap; }
  .cx-context strong { color: var(--cx-text); font-weight: 600; }
  .cx-context .gate-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--cx-changed); display: inline-block; }
  .cx-context .gate-dot.warn { background: var(--cx-modified); }
  .cx-actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; justify-content: flex-end; }
  .cx-depth { display: inline-flex; align-items: center; height: 28px; border: 1px solid var(--cx-line-strong); border-radius: 4px; overflow: hidden; font-family: var(--cx-mono); font-size: 11.5px; }
  .cx-depth > span { padding: 0 .55rem; color: var(--cx-dim); }
  #cx-root .cx-depth button { width: 26px; height: 26px; justify-content: center; border-left: 1px solid var(--cx-line); }
  #cx-root .cx-view-mode button { width: auto; padding: 0 .6rem; }
  #cx-root .cx-depth button[aria-pressed="true"] { background: color-mix(in srgb, var(--cx-changed) 22%, transparent); color: var(--cx-changed); font-weight: 700; }

  .cx-tabs { display: flex; align-items: stretch; gap: .25rem; padding: 0 1rem; border-bottom: 1px solid var(--cx-line); min-width: 0; overflow-x: auto; }
  #cx-root .cx-tab { gap: .55rem; padding: .55rem .8rem .5rem; border-bottom: 2px solid transparent; color: var(--cx-dim); font-family: var(--cx-mono); font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
  #cx-root .cx-tab:hover:not(:disabled) { color: var(--cx-text); }
  #cx-root .cx-tab[aria-selected="true"] { color: var(--cx-text); border-bottom-color: var(--cx-changed); }
  .cx-tab .cx-count { padding: 0 .35rem; border: 1px solid var(--cx-line-strong); border-radius: 3px; font-size: 10px; color: var(--cx-dim); }
  .cx-legend { margin-left: auto; display: flex; align-items: center; gap: .9rem; color: var(--cx-dim); font-family: var(--cx-mono); font-size: 10.5px; white-space: nowrap; }
  .cx-legend span { display: inline-flex; align-items: center; gap: .35rem; }
  .cx-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; background: var(--cx-other); }
  .cx-dot.changed { background: var(--cx-changed); } .cx-dot.caller { background: var(--cx-caller); } .cx-dot.callee { background: var(--cx-callee); }
  .cx-dot.test { background: var(--cx-test); } .cx-dot.external { background: var(--cx-external); } .cx-dot.focus { background: var(--cx-focus); } .cx-dot.repository { background: var(--cx-repository); } .cx-dot.context { background: var(--cx-faint); }

  .cx-main { display: grid; grid-template-columns: var(--cx-outline-w) minmax(0, 1fr) 6px var(--cx-inspector-w); min-height: 0; min-width: 0; }
  .cx-main.no-outline { grid-template-columns: 0 minmax(0, 1fr) 6px var(--cx-inspector-w); }
  .cx-main.no-outline .cx-outline { visibility: hidden; }
  .cx-outline { display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; border-right: 1px solid var(--cx-line); background: var(--cx-card); overflow: hidden; }
  .cx-search { display: flex; align-items: center; gap: .35rem; padding: 0 .45rem; height: 28px; width: 150px; border: 1px solid var(--cx-line-strong); border-radius: 4px;
    background: var(--sf-surface-sunken, var(--vscode-input-background)); color: var(--cx-dim); transition: width .15s ease; }
  .cx-search:focus-within { width: 220px; border-color: var(--cx-changed); }
  #cx-root .cx-search input { flex: 1 1 auto; width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--cx-text); font: inherit; font-family: var(--cx-mono); font-size: 12px; padding: 0; min-height: 0; box-shadow: none; }
  .cx-tree { overflow: auto; padding: .5rem .35rem .8rem; }
  .cx-tree-group { margin: .35rem 0 .15rem; }
  #cx-root .cx-tree-module { width: 100%; gap: .4rem; padding: .25rem .35rem; border-radius: 3px; font-family: var(--cx-mono); font-size: 11.5px; color: var(--cx-text); text-align: left; }
  #cx-root .cx-tree-module small { color: var(--cx-faint); margin-left: auto; padding-left: .4rem; }
  #cx-root .cx-tree-symbol { width: 100%; gap: .4rem; padding: .18rem .35rem .18rem 1.35rem; border-radius: 3px; font-family: var(--cx-mono); font-size: 11.5px; color: var(--cx-dim); text-align: left; }
  #cx-root .cx-tree-symbol:hover:not(:disabled), #cx-root .cx-tree-module:hover:not(:disabled) { background: color-mix(in srgb, var(--cx-changed) 10%, transparent); color: var(--cx-text); }
  #cx-root .cx-tree-symbol.selected { background: color-mix(in srgb, var(--cx-changed) 20%, transparent); color: var(--cx-text); }
  .cx-tree-symbol .nm, .cx-tree-module .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .cx-tree-empty { padding: .6rem; color: var(--cx-faint); font-size: 12px; }

  .cx-stage { position: relative; min-width: 0; min-height: 0; display: grid; }
  .cx-view { position: relative; min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); container-type: inline-size; }
  .cx-toolbar { display: flex; align-items: center; gap: .45rem; padding: .4rem .6rem; border-bottom: 1px solid var(--cx-line); flex-wrap: nowrap; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .cx-toolbar::-webkit-scrollbar { display: none; }
  .cx-toolbar > * { flex: none; }
  /* The filters give way first: they shrink and scroll inside their own strip, so the zoom and
     layout buttons stay reachable at any width. */
  .cx-toolbar > .cx-filters { flex: 0 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .cx-toolbar > .cx-filters::-webkit-scrollbar { display: none; }
  @container (max-width: 1280px) { .cx-toolbar > .cx-label { display: none; } }
  @container (max-width: 980px) { .cx-zoom output { display: none; } .cx-search { width: 110px; } }
  @container (max-width: 760px) { .cx-filters .cx-filter .n { display: none; } }
  .cx-label { font-family: var(--cx-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--cx-dim); white-space: nowrap; }
  .cx-label b { color: var(--cx-changed); font-weight: 650; }
  .cx-filters { display: flex; gap: .3rem; flex-wrap: nowrap; }
  .cx-filters > .cx-filter { flex: none; }
  #cx-root .cx-filter { gap: .35rem; height: 24px; padding: 0 .5rem; border: 1px solid var(--cx-line-strong); border-radius: 12px; font-family: var(--cx-mono); font-size: 10.5px; color: var(--cx-dim); }
  #cx-root .cx-filter[aria-pressed="true"] { color: var(--cx-text); border-color: color-mix(in srgb, var(--cx-text) 40%, transparent); background: color-mix(in srgb, var(--cx-text) 6%, transparent); }
  #cx-root .cx-filter[aria-pressed="false"] .cx-dot { opacity: .35; }
  .cx-spacer { flex: 1 1 auto; }
  .cx-zoom { display: inline-flex; gap: .3rem; align-items: center; }
  .cx-zoom output { min-width: 3.2rem; text-align: center; font-family: var(--cx-mono); font-size: 11px; color: var(--cx-dim); }

  .cx-canvas { position: relative; overflow: hidden; min-height: 0; cursor: grab; outline: none; touch-action: none;
    background-color: var(--sf-bg, var(--vscode-editor-background));
    background-image: radial-gradient(var(--cx-grid) 1px, transparent 1.2px); background-size: 22px 22px; }
  .cx-canvas.panning { cursor: grabbing; }
  .cx-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .cx-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .cx-edges .edge { fill: none; stroke: var(--cx-edge); stroke-width: 1.4; transition: stroke .15s, opacity .15s; }
  .cx-edges .edge.back { stroke-dasharray: 5 4; }
  .cx-edges .hit { fill: none; stroke: transparent; stroke-width: 12; pointer-events: stroke; cursor: pointer; }
  .cx-edges .edge.active { stroke: var(--cx-changed); stroke-width: 2.2; }
  .cx-edges .edge.active.in { stroke: var(--cx-caller); }
  .cx-edges .edge.active.out { stroke: var(--cx-callee); }
  .cx-edges .edge.flow { stroke-dasharray: 7 5; animation: cx-flow .9s linear infinite; }
  .cx-edges .edge.dim { opacity: .14; }
  .cx-edges .edge-label { font-family: var(--cx-mono); font-size: 10px; fill: var(--cx-dim); paint-order: stroke; stroke: var(--sf-bg, var(--vscode-editor-background)); stroke-width: 3px; }
  .cx-edges marker path { fill: var(--cx-edge); }
  .cx-edges marker.active path { fill: var(--cx-changed); }
  .cx-edges marker.in path { fill: var(--cx-caller); }
  .cx-edges marker.out path { fill: var(--cx-callee); }
  @keyframes cx-flow { to { stroke-dashoffset: -24; } }
  @media (prefers-reduced-motion: reduce) { .cx-edges .edge.flow { animation: none; } .cx-node { transition: none !important; } }

  .cx-node { position: absolute; width: 300px; border: 1px solid var(--cx-line-strong); border-radius: 6px; background: var(--cx-card);
    box-shadow: 0 10px 28px -18px rgba(0,0,0,.65); transition: transform .28s ease, opacity .15s, border-color .15s, box-shadow .15s; }
  .cx-node.dragging { transition: none; z-index: 5; }
  .cx-node.changed { border-color: color-mix(in srgb, var(--cx-changed) 70%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--cx-changed) 35%, transparent), 0 0 30px -10px color-mix(in srgb, var(--cx-changed) 55%, transparent); }
  .cx-node.focus { border-color: var(--cx-focus); }
  .cx-node.repository { border-color: color-mix(in srgb, var(--cx-repository) 60%, transparent); }
  .cx-node.dim { opacity: .28; }
  .cx-node.selected-module { border-color: var(--cx-changed); box-shadow: 0 0 0 2px color-mix(in srgb, var(--cx-changed) 45%, transparent); }
  .cx-node-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto auto; align-items: center; gap: .45rem; padding: .5rem .55rem .45rem .6rem;
    border-bottom: 1px solid var(--cx-line); background: var(--cx-card-head); border-radius: 6px 6px 0 0; cursor: move; }
  .cx-node-head .file { min-width: 0; }
  .cx-node-head .file b { display: block; font-family: var(--cx-mono); font-size: 12.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-node-head .file small { display: block; font-family: var(--cx-mono); font-size: 10px; color: var(--cx-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-role { height: 18px; padding: 0 .4rem; display: inline-flex; align-items: center; border-radius: 3px; font-family: var(--cx-mono); font-size: 9.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: #0b0e0c; background: var(--cx-other); }
  .cx-role.changed { background: var(--cx-changed); } .cx-role.caller { background: var(--cx-caller); } .cx-role.callee { background: var(--cx-callee); }
  .cx-role.test { background: var(--cx-test); } .cx-role.external { background: var(--cx-external); } .cx-role.focus { background: var(--cx-focus); } .cx-role.repository { background: var(--cx-repository); } .cx-role.context { background: var(--cx-faint); }
  .cx-delta { font-family: var(--cx-mono); font-size: 10.5px; white-space: nowrap; }
  .cx-delta .add { color: var(--cx-added); } .cx-delta .del { color: var(--cx-removed); }
  #cx-root .cx-collapse { width: 20px; height: 20px; justify-content: center; color: var(--cx-dim); border-radius: 3px; }
  #cx-root .cx-collapse:hover:not(:disabled) { color: var(--cx-text); background: color-mix(in srgb, var(--cx-text) 10%, transparent); }
  .cx-rows { padding: .25rem 0 .3rem; }
  #cx-root .cx-row { position: relative; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: .45rem; align-items: center; width: 100%; height: 26px;
    padding: 0 .6rem 0 .55rem; font-family: var(--cx-mono); font-size: 11.5px; text-align: left; color: var(--cx-text); border-left: 2px solid transparent; }
  #cx-root .cx-row:hover:not(:disabled) { background: color-mix(in srgb, var(--cx-text) 6%, transparent); }
  #cx-root .cx-row.added { border-left-color: var(--cx-added); } #cx-root .cx-row.modified { border-left-color: var(--cx-modified); } #cx-root .cx-row.removed { border-left-color: var(--cx-removed); }
  #cx-root .cx-row.removed .nm { text-decoration: line-through; color: var(--cx-dim); }
  #cx-root .cx-row.k-module-scope .nm, #cx-root .cx-row.k-file .nm { color: var(--cx-dim); font-style: italic; }
  #cx-root .cx-row.selected { background: color-mix(in srgb, var(--cx-changed) 20%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cx-changed) 70%, transparent); }
  #cx-root .cx-row.related { background: color-mix(in srgb, var(--cx-caller) 13%, transparent); }
  #cx-root .cx-row.related.out { background: color-mix(in srgb, var(--cx-callee) 13%, transparent); }
  #cx-root .cx-row.match .nm { color: var(--cx-changed); text-decoration: underline; text-underline-offset: 3px; }
  #cx-root .cx-row.dim { opacity: .35; }
  .cx-row .kind { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 3px; font-size: 9.5px; font-weight: 700; color: var(--cx-dim); border: 1px solid var(--cx-line-strong); }
  .cx-row .kind.k-method { color: var(--cx-callee); } .cx-row .kind.k-function { color: var(--cx-caller); } .cx-row .kind.k-class { color: var(--cx-test); }
  .cx-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-row .meta { display: inline-flex; align-items: center; gap: .35rem; color: var(--cx-faint); font-size: 10.5px; }
  .cx-tag { padding: 0 .3rem; border: 1px solid currentColor; border-radius: 3px; font-size: 9px; font-weight: 700; letter-spacing: .05em; line-height: 14px; }
  .cx-tag.t-test { color: var(--cx-test); } .cx-tag.t-req { color: var(--cx-caller); } .cx-tag.t-new { color: var(--cx-added); } .cx-tag.t-gone { color: var(--cx-removed); }
  #cx-root .cx-more { width: 100%; height: 22px; padding: 0 .6rem 0 1.9rem; color: var(--cx-dim); font-family: var(--cx-mono); font-size: 10.5px; }
  #cx-root .cx-more:hover:not(:disabled) { color: var(--cx-text); }
  .cx-node-foot { display: flex; align-items: center; gap: .5rem; padding: .3rem .6rem .4rem; border-top: 1px dashed var(--cx-line); color: var(--cx-faint); font-family: var(--cx-mono); font-size: 10px; }

  .cx-minimap { position: absolute; right: 10px; bottom: 10px; width: 150px; height: 96px; border: 1px solid var(--cx-line-strong); border-radius: 4px; opacity: .92;
    background: color-mix(in srgb, var(--cx-card) 92%, transparent); overflow: hidden; cursor: pointer; }
  .cx-minimap svg { width: 100%; height: 100%; display: block; }
  .cx-minimap rect.mm-node { fill: color-mix(in srgb, var(--cx-text) 25%, transparent); }
  .cx-minimap rect.mm-node.changed { fill: var(--cx-changed); } .cx-minimap rect.mm-node.caller { fill: var(--cx-caller); } .cx-minimap rect.mm-node.callee { fill: var(--cx-callee); } .cx-minimap rect.mm-node.test { fill: var(--cx-test); }
  .cx-minimap rect.mm-view { fill: color-mix(in srgb, var(--cx-changed) 10%, transparent); stroke: var(--cx-changed); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .cx-canvas-note { position: absolute; left: 12px; bottom: 10px; max-width: min(520px, 70%); padding: .45rem .6rem; border: 1px solid var(--cx-line-strong); border-radius: 4px;
    background: color-mix(in srgb, var(--cx-card) 94%, transparent); color: var(--cx-dim); font-size: 11.5px; }
  .cx-progress { position: absolute; left: 0; right: 0; top: 0; height: 2px; overflow: hidden; }
  .cx-progress::after { content: ''; position: absolute; top: 0; bottom: 0; width: 30%; background: var(--cx-changed); animation: cx-slide 1.1s ease-in-out infinite; }
  @keyframes cx-slide { from { left: -30%; } to { left: 100%; } }
  .cx-tooltip { position: fixed; z-index: 20; max-width: 340px; padding: .45rem .6rem; border: 1px solid var(--cx-line-strong); border-radius: 4px; pointer-events: none;
    background: var(--cx-card-head); color: var(--cx-text); font-family: var(--cx-mono); font-size: 11px; line-height: 1.5; box-shadow: 0 8px 22px -12px rgba(0,0,0,.7); }
  .cx-tooltip .tt-name { font-weight: 700; color: var(--cx-changed); }
  .cx-tooltip .tt-dim { color: var(--cx-dim); }

  .cx-splitter { cursor: col-resize; background: var(--cx-line); outline: none; }
  .cx-splitter:hover, .cx-splitter:focus-visible, .cx-splitter.dragging { background: var(--cx-changed); }
  .cx-inspector { min-height: 0; overflow: auto; padding: .9rem 1rem 1.2rem; background: var(--cx-card); }
  .cx-ins-eyebrow { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .5rem; }
  .cx-ins-title { margin: .1rem 0 .15rem; font-family: var(--cx-mono); font-size: 15px; font-weight: 700; color: var(--cx-changed); overflow-wrap: anywhere; }
  .cx-ins-path { font-family: var(--cx-mono); font-size: 11px; color: var(--cx-dim); overflow-wrap: anywhere; }
  .cx-badges { display: flex; flex-wrap: wrap; gap: .3rem; margin: .55rem 0 .2rem; }
  .cx-ins-actions { display: flex; flex-wrap: wrap; gap: .35rem; margin: .7rem 0 .2rem; }
  .cx-box { margin: .8rem 0 0; padding: .7rem .75rem; border: 1px solid var(--cx-line); border-radius: 5px; background: var(--sf-bg, var(--vscode-editor-background)); }
  .cx-box > h3 { display: flex; align-items: center; justify-content: space-between; gap: .4rem; margin: 0 0 .45rem; font-family: var(--cx-mono); font-size: 10.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--cx-dim); }
  .cx-box > h3 small { font-weight: 500; letter-spacing: .02em; text-transform: none; color: var(--cx-faint); }
  .cx-explain p { margin: 0 0 .45rem; line-height: 1.5; }
  .cx-explain p:last-child { margin-bottom: 0; }
  .cx-explain code { padding: 0 .25rem; border-radius: 3px; background: color-mix(in srgb, var(--cx-text) 8%, transparent); }
  .cx-explain .cx-nowrap { white-space: nowrap; }
  #cx-root .cx-ref { display: inline; padding: 0; color: var(--sf-link, var(--vscode-textLink-foreground)); font-family: var(--cx-mono); font-size: .95em; text-decoration: underline dotted; text-underline-offset: 3px; }
  .cx-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; margin-top: .8rem; }
  .cx-metric { padding: .55rem .65rem; border: 1px solid var(--cx-line); border-radius: 5px; background: var(--sf-bg, var(--vscode-editor-background)); min-width: 0; }
  .cx-metric .k { font-family: var(--cx-mono); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--cx-dim); }
  .cx-metric .v { margin-top: .15rem; font-family: var(--cx-mono); font-size: 20px; font-weight: 700; color: var(--cx-text); white-space: nowrap; }
  .cx-metric .v small { font-size: 11px; font-weight: 500; color: var(--cx-dim); }
  .cx-metric .s { margin-top: .1rem; font-family: var(--cx-mono); font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--cx-faint); }
  .cx-metric .s.good { color: var(--cx-changed); } .cx-metric .s.warn { color: var(--cx-modified); } .cx-metric .s.bad { color: var(--cx-removed); }
  .cx-meter { height: 4px; margin-top: .35rem; border-radius: 2px; background: color-mix(in srgb, var(--cx-text) 10%, transparent); overflow: hidden; }
  .cx-meter i { display: block; height: 100%; background: var(--cx-changed); }
  .cx-meter i.warn { background: var(--cx-modified); } .cx-meter i.bad { background: var(--cx-removed); }
  .cx-code { margin: 0; padding: .55rem .65rem; overflow: auto; max-height: 220px; border-radius: 4px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
    font-family: var(--cx-mono); font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .cx-code .kw { color: var(--cx-callee); } .cx-code .ty { color: var(--cx-test); } .cx-code .st { color: var(--cx-added); }
  .cx-diff { margin: 0; overflow: auto; max-height: 340px; border-radius: 4px; font-family: var(--cx-mono); font-size: 11px; line-height: 1.5; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); }
  .cx-diff-line { display: grid; grid-template-columns: 2.6rem 2.6rem 1rem minmax(0, 1fr); white-space: pre; }
  .cx-diff-line > span { padding: 0 .3rem; }
  .cx-diff-line .ln { color: var(--cx-faint); text-align: right; user-select: none; }
  .cx-diff-line .tx { white-space: pre-wrap; overflow-wrap: anywhere; }
  .cx-diff-line.add { background: color-mix(in srgb, var(--cx-added) 14%, transparent); } .cx-diff-line.add .mk { color: var(--cx-added); }
  .cx-diff-line.del { background: color-mix(in srgb, var(--cx-removed) 14%, transparent); } .cx-diff-line.del .mk { color: var(--cx-removed); }
  .cx-diff-line.gap { color: var(--cx-faint); }
  .cx-links { display: grid; gap: .2rem; margin: 0; padding: 0; list-style: none; }
  .cx-links li { display: flex; align-items: center; gap: .45rem; min-width: 0; font-family: var(--cx-mono); font-size: 11.5px; }
  #cx-root .cx-links button.go { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sf-link, var(--vscode-textLink-foreground)); }
  #cx-root .cx-links button.go:hover:not(:disabled) { text-decoration: underline; }
  .cx-links .where { margin-left: auto; color: var(--cx-faint); font-size: 10.5px; white-space: nowrap; }
  .cx-muted { color: var(--cx-dim); font-size: 12px; margin: 0; }
  .cx-empty { display: grid; place-content: center; gap: .6rem; padding: 2rem; text-align: center; color: var(--cx-dim); }
  .cx-empty h2 { margin: 0; color: var(--cx-text); font-size: 15px; }
  .cx-empty p { margin: 0; max-width: 34rem; }

  .cx-trace { overflow: auto; position: relative; min-height: 0; }
  .cx-repo { overflow: auto; min-height: 0; padding: .8rem 1rem 2rem; display: grid; gap: 1rem; align-content: start; }
  .cx-repo-summary { display: grid; gap: .25rem; font-size: 12px; color: var(--cx-dim); }
  .cx-repo-summary strong { color: var(--cx-text); }
  .cx-repo h3 { margin: 0 0 .4rem; font-family: var(--cx-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--cx-dim); }
  .cx-repo-entries { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .5rem; }
  #cx-root .cx-repo-entry { text-align: left; display: grid; justify-content: stretch; gap: .15rem; padding: .5rem .65rem; border: 1px solid var(--cx-line); border-radius: 6px; background: transparent; color: var(--cx-text); cursor: pointer; }
  #cx-root .cx-repo-entry:hover, #cx-root .cx-repo-entry:focus-visible { border-color: var(--cx-changed); }
  .cx-repo-entry small { color: var(--cx-dim); font-size: 11px; }
  .cx-repo-file { display: grid; gap: .2rem; padding: .45rem 0; border-top: 1px solid var(--cx-line); }
  .cx-repo-file .head { display: flex; gap: .5rem; align-items: baseline; font-family: var(--cx-mono); font-size: 12px; }
  .cx-repo-file .head small { color: var(--cx-dim); font-family: inherit; }
  .cx-repo-syms { display: flex; flex-wrap: wrap; gap: .3rem; }
  #cx-root .cx-repo-sym { font-family: var(--cx-mono); font-size: 11.5px; border: 1px solid var(--cx-line); border-radius: 4px; padding: .1rem .45rem; background: transparent; color: var(--cx-text); cursor: pointer; }
  #cx-root .cx-repo-sym:hover, #cx-root .cx-repo-sym:focus-visible { border-color: var(--cx-changed); }
  .cx-repo-tag { font-size: 11.5px; color: var(--cx-dim); }
  .cx-trace-summary { display: flex; flex-wrap: wrap; gap: .5rem 1.2rem; align-items: center; padding: .55rem .9rem; border-bottom: 1px solid var(--cx-line); font-family: var(--cx-mono); font-size: 11.5px; color: var(--cx-dim); }
  .cx-trace-summary strong { color: var(--cx-text); }
  .cx-trace-grid { position: relative; display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 0 44px; padding: 1rem 1rem 2rem; min-width: 860px; }
  .cx-trace-col h3 { display: flex; align-items: center; gap: .45rem; margin: 0 0 .7rem; font-family: var(--cx-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--cx-dim); }
  .cx-trace-col h3 .n { color: var(--cx-text); }
  #cx-root .cx-tcard { position: relative; z-index: 1; display: grid; gap: .25rem; width: 100%; margin: 0 0 .6rem; padding: .55rem .65rem; border: 1px solid var(--cx-line-strong); border-radius: 5px;
    background: var(--cx-card); text-align: left; font-size: 12px; line-height: 1.4; }
  #cx-root .cx-tcard:hover:not(:disabled) { border-color: var(--cx-changed); }
  #cx-root .cx-tcard.lit { border-color: var(--cx-changed); box-shadow: 0 0 0 1px color-mix(in srgb, var(--cx-changed) 45%, transparent); }
  #cx-root .cx-tcard.dim { opacity: .3; }
  .cx-tcard .id { font-family: var(--cx-mono); font-size: 11px; font-weight: 700; display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
  .cx-tcard .tx { color: var(--cx-dim); }
  .cx-tcard .sym { font-family: var(--cx-mono); font-size: 11px; color: var(--cx-text); }
  .cx-trace-links { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
  .cx-trace-links path { fill: none; stroke: var(--cx-edge); stroke-width: 1.4; }
  .cx-trace-links path.tag { stroke: var(--cx-test); }
  .cx-trace-links path.region { stroke: var(--cx-caller); stroke-dasharray: 4 3; }
  .cx-trace-links path.declared { stroke: var(--cx-test); stroke-dasharray: 1.5 3; }
  .cx-trace-links path.reference { stroke: var(--cx-callee); }
  .cx-trace-links path.lit { stroke-width: 2.4; }
  .cx-trace-links path.dim { opacity: .12; }
  .cx-trace-note { margin: 0 1rem 1rem; color: var(--cx-faint); font-size: 11.5px; }

  .cx-walk { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 0; }
  .cx-steps { overflow: auto; border-right: 1px solid var(--cx-line); padding: .6rem .4rem; }
  #cx-root .cx-step { display: grid; grid-template-columns: 1.6rem minmax(0, 1fr); gap: .45rem; width: 100%; padding: .4rem .45rem; border-radius: 4px; text-align: left; align-items: start; }
  #cx-root .cx-step:hover:not(:disabled) { background: color-mix(in srgb, var(--cx-text) 6%, transparent); }
  #cx-root .cx-step.current { background: color-mix(in srgb, var(--cx-changed) 16%, transparent); }
  .cx-step .no { display: grid; place-items: center; width: 1.45rem; height: 1.45rem; border-radius: 50%; border: 1px solid var(--cx-line-strong); font-family: var(--cx-mono); font-size: 10.5px; color: var(--cx-dim); }
  .cx-step.current .no { border-color: var(--cx-changed); color: var(--cx-changed); }
  .cx-step .nm { font-family: var(--cx-mono); font-size: 11.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
  .cx-step small { display: block; color: var(--cx-faint); font-family: var(--cx-mono); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-walk-body { overflow: auto; padding: 1rem 1.2rem 2rem; min-width: 0; }
  .cx-walk-head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  #cx-root .cx-walk-head h2 { margin: 0; font-family: var(--cx-mono); font-size: 17px; color: var(--cx-changed); overflow-wrap: anywhere; text-transform: none; letter-spacing: 0; }
  .cx-main.walk-mode { grid-template-columns: var(--cx-outline-w) minmax(0, 1fr) 0 0; }
  .cx-main.walk-mode .cx-inspector, .cx-main.walk-mode .cx-splitter { display: none; }
  .cx-main.no-outline.walk-mode { grid-template-columns: 0 minmax(0, 1fr) 0 0; }
  .cx-walk-nav { display: flex; gap: .4rem; margin-left: auto; }
  .cx-walk-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: .9rem; margin-top: .8rem; }
  @media (max-width: 1100px) { .cx-walk-grid { grid-template-columns: minmax(0, 1fr); } }

  .cx-status { display: flex; align-items: center; gap: .9rem; padding: .4rem 1rem; border-top: 1px solid var(--cx-line); font-family: var(--cx-mono); font-size: 11px; color: var(--cx-dim); min-width: 0; flex-wrap: wrap; }
  .cx-status .seg { display: inline-flex; align-items: center; gap: .35rem; white-space: nowrap; }
  .cx-status .seg.ok { color: var(--cx-changed); } .cx-status .seg.warn { color: var(--cx-modified); }
  #cx-root .cx-status .cx-attn { gap: .35rem; color: var(--cx-modified); text-decoration: underline dotted; text-underline-offset: 3px; }
  #cx-root .cx-status .cx-engine, #cx-root .cx-status .cx-attn.quiet { color: var(--cx-dim); }
  .cx-status .cx-btns { margin-left: auto; display: flex; gap: .4rem; flex-wrap: wrap; }
  .cx-popover { position: absolute; right: 1rem; bottom: 2.6rem; z-index: 30; width: min(520px, calc(100vw - 2rem)); max-height: 50vh; overflow: auto; padding: .7rem .8rem;
    border: 1px solid var(--cx-line-strong); border-radius: 6px; background: var(--cx-card-head); box-shadow: 0 16px 40px -20px rgba(0,0,0,.8); }
  .cx-popover h3 { margin: 0 0 .4rem; font-family: var(--cx-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--cx-dim); }
  .cx-popover ul { margin: 0; padding-left: 1rem; display: grid; gap: .35rem; font-size: 12px; }
  .cx-notice { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); z-index: 25; max-width: min(640px, 90%); padding: .45rem .75rem; border: 1px solid var(--cx-line-strong);
    border-radius: 4px; background: var(--cx-card-head); font-size: 12px; box-shadow: 0 10px 30px -16px rgba(0,0,0,.8); }
  .cx-notice.warn { border-color: var(--cx-modified); } .cx-notice.bad { border-color: var(--cx-removed); }
  .cx-stale { display: inline-flex; align-items: center; gap: .4rem; }
  @media (max-width: 980px) {
    #cx-root { --cx-inspector-w: 300px; --cx-outline-w: 0px; }
    .cx-main { grid-template-columns: 0 minmax(0, 1fr) 6px var(--cx-inspector-w); }
    .cx-outline { visibility: hidden; }
    .cx-legend { display: none; }
  }

  /* Lenses: the bar, and the four lens views. */
  .cx-head { grid-row: 1; } .cx-lenses { grid-row: 2; } .cx-tabs { grid-row: 3; } .cx-main { grid-row: 4; } .cx-status { grid-row: 5; }
  .cx-lenses { display: flex; gap: .4rem; padding: .45rem 1rem; border-bottom: 1px solid var(--cx-line); overflow-x: auto; min-width: 0; }
  #cx-root .cx-lens { flex: none; display: grid; gap: .05rem; justify-items: start; padding: .3rem .75rem; border: 1px solid var(--cx-line); border-radius: 6px; background: var(--cx-card); color: var(--cx-dim); }
  #cx-root .cx-lens b { font-size: 12.5px; font-weight: 650; color: var(--cx-text); }
  #cx-root .cx-lens small { font-size: 10.5px; color: var(--cx-faint); }
  #cx-root .cx-lens:hover:not(:disabled) { border-color: var(--cx-line-strong); }
  #cx-root .cx-lens[aria-selected="true"] { border-color: var(--cx-changed); background: color-mix(in srgb, var(--cx-changed) 10%, var(--cx-card)); }
  #cx-root .cx-lens[aria-selected="true"] small { color: var(--cx-dim); }
  .cx-main.lens-mode { grid-template-columns: 0 minmax(0, 1fr) 6px var(--cx-inspector-w); }
  .cx-main.lens-mode .cx-outline { visibility: hidden; }
  .cx-select { height: 26px; min-width: 0; max-width: min(520px, 60%); padding: 0 .4rem; border: 1px solid var(--cx-line-strong); border-radius: 4px; background: var(--cx-card); color: var(--cx-text); font-family: var(--cx-mono); font-size: 11.5px; }
  .cx-lens-body { overflow: auto; min-height: 0; padding: .8rem 1rem 2rem; display: grid; gap: 1.1rem; align-content: start; }
  .cx-lens-summary { margin: 0; font-size: 13px; line-height: 1.5; color: var(--cx-text); max-width: 72rem; }
  .cx-lens-section { display: grid; gap: .55rem; min-width: 0; }
  .cx-lens-section > h3 { display: flex; align-items: baseline; gap: .6rem; margin: 0; font-family: var(--cx-mono); font-size: 10.5px; font-weight: 650; letter-spacing: .1em; text-transform: uppercase; color: var(--cx-dim); }
  .cx-lens-section > h3 small { font-weight: 500; letter-spacing: .02em; text-transform: none; color: var(--cx-faint); }
  .cx-lens-scroll { overflow: auto; max-width: 100%; padding-bottom: .5rem; }
  .cx-lens-world { position: relative; }
  .cx-lens-links { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .cx-lens-links .line, .cx-lens-links .flow-line { fill: none; stroke: var(--cx-edge); stroke-width: 1.4; }
  .cx-lens-links .dashed { stroke-dasharray: 5 4; }
  .cx-lens-links .back { stroke: color-mix(in srgb, var(--cx-callee) 70%, transparent); }
  .cx-lens-links .arrow { fill: none; stroke: var(--cx-edge); stroke-width: 1.5; }
  .cx-lens-links .hit { fill: none; stroke: transparent; stroke-width: 12; pointer-events: stroke; cursor: pointer; }
  .cx-lens-links .label-bg { fill: var(--sf-bg, var(--vscode-editor-background)); stroke: var(--cx-line); }
  .cx-lens-links .label, .cx-lens-links .flow-label { fill: var(--cx-dim); font-family: var(--cx-mono); font-size: 10.5px; }
  .cx-lens-links .lens-link.selected .line { stroke: var(--cx-changed); stroke-width: 2.2; }
  .cx-lens-links .lens-link.error .line { stroke: color-mix(in srgb, var(--cx-removed) 70%, transparent); }
  .cx-lens-links .lens-link.writes .line { stroke: color-mix(in srgb, var(--cx-modified) 75%, transparent); }
  #cx-root .cx-layer { position: absolute; left: 0; top: 0; display: grid; align-content: start; gap: .12rem; padding: .5rem .7rem; border: 1px solid var(--cx-line-strong); border-radius: 8px; background: var(--cx-card); text-align: left; overflow: hidden; justify-items: stretch; }
  .cx-layer .head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; margin-bottom: .2rem; }
  .cx-layer .head b { font-size: 12.5px; }
  .cx-layer .head small, .cx-layer .more { color: var(--cx-faint); font-size: 10.5px; }
  .cx-layer .file { font-family: var(--cx-mono); font-size: 11px; color: var(--cx-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cx-layer.entry { border-top: 3px solid var(--cx-changed); } .cx-layer.ui { border-top: 3px solid var(--cx-caller); } .cx-layer.logic { border-top: 3px solid var(--cx-callee); }
  .cx-layer.data { border-top: 3px solid var(--cx-test); } .cx-layer.storage { border-top: 3px solid var(--cx-focus); } .cx-layer.cross-cutting { border-top: 3px solid var(--cx-modified); }
  #cx-root .selected.cx-layer, #cx-root .selected.cx-concept, #cx-root .selected.cx-entity, #cx-root .selected.cx-flow-node, #cx-root .selected.cx-logic-node { outline: 2px solid var(--cx-changed); outline-offset: 1px; }
  .cx-concepts { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: .5rem; }
  #cx-root .cx-concept { display: grid; gap: .3rem; justify-items: start; padding: .55rem .7rem; border: 1px solid var(--cx-line); border-radius: 8px; background: var(--cx-card); text-align: left; }
  .cx-concept b { font-size: 13px; }
  .cx-concept .bar { width: 100%; height: 4px; border-radius: 2px; background: var(--cx-grid); overflow: hidden; }
  .cx-concept .bar i { display: block; height: 100%; background: var(--cx-changed); }
  .cx-concept small { color: var(--cx-dim); font-size: 11px; }
  .cx-concept .related { display: flex; flex-wrap: wrap; gap: .25rem; }
  .cx-tag { display: inline-flex; padding: 0 .35rem; border: 1px solid var(--cx-line-strong); border-radius: 3px; font-family: var(--cx-mono); font-size: 10.5px; color: var(--cx-dim); }
  .cx-entity { position: absolute; left: 0; top: 0; width: 300px; border: 1px solid var(--cx-line-strong); border-radius: 8px; background: var(--cx-card); cursor: pointer; overflow: hidden; }
  .cx-entity-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: .6rem; align-items: start; }
  .cx-entity-grid .cx-entity { position: relative; width: auto; }
  .cx-entity .head { display: flex; align-items: center; justify-content: space-between; gap: .4rem; padding: .45rem .6rem .1rem; }
  .cx-entity .head b { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-entity .where { padding: 0 .6rem .35rem; color: var(--cx-faint); font-family: var(--cx-mono); font-size: 10.5px; border-bottom: 1px solid var(--cx-line); }
  .cx-entity .fields { display: grid; padding: .25rem 0; }
  .cx-entity .field { display: flex; align-items: baseline; gap: .45rem; height: 19px; padding: 0 .6rem; font-family: var(--cx-mono); font-size: 11px; white-space: nowrap; overflow: hidden; }
  #cx-root .cx-fname { text-transform: none; letter-spacing: normal; font-weight: 500; color: var(--cx-text); }
  #cx-root .cx-ftype { text-transform: none; letter-spacing: normal; font-weight: 400; color: var(--cx-callee); overflow: hidden; text-overflow: ellipsis; }
  .cx-entity .field .acc { margin-left: auto; color: var(--cx-faint); font-size: 10px; }
  .cx-entity .field.more { color: var(--cx-faint); }
  .cx-entity .values { display: flex; flex-wrap: wrap; gap: .25rem; padding: .2rem .6rem .35rem; max-height: 30px; overflow: hidden; }
  .cx-entity .foot { display: flex; justify-content: space-between; gap: .5rem; padding: .25rem .6rem; border-top: 1px solid var(--cx-line); color: var(--cx-faint); font-size: 10.5px; }
  .cx-entity.enum { border-top: 3px solid var(--cx-modified); } .cx-entity.props { border-top: 3px solid var(--cx-caller); } .cx-entity.shape { border-top: 3px solid var(--cx-focus); }
  .cx-field-table { display: grid; gap: .2rem; }
  .cx-field-table .row { display: flex; align-items: baseline; gap: .5rem; font-size: 11.5px; }
  .cx-field-table .cx-ftype { font-family: var(--cx-mono); font-size: 11px; }
  .cx-field-table .acc { color: var(--cx-faint); font-size: 10.5px; }
  #cx-root .cx-flow-node { position: absolute; left: 0; top: 0; display: grid; align-content: start; justify-items: stretch; gap: .1rem; padding: .4rem .65rem; border: 1px solid var(--cx-line-strong); border-radius: 8px; background: var(--cx-card); text-align: left; overflow: hidden; }
  .cx-flow-node .kind { color: var(--cx-faint); font-family: var(--cx-mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
  .cx-flow-node b { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-flow-node .detail { color: var(--cx-dim); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-flow-node .conv { color: var(--cx-modified); font-family: var(--cx-mono); font-size: 10.5px; }
  #cx-root .cx-flow-node.entry { border-color: var(--cx-changed); background: color-mix(in srgb, var(--cx-changed) 12%, var(--cx-card)); }
  #cx-root .cx-flow-node.state { border-color: var(--cx-modified); border-style: dashed; }
  #cx-root .cx-flow-node.sink { border-color: var(--cx-callee); background: color-mix(in srgb, var(--cx-callee) 10%, var(--cx-card)); }
  #cx-root .cx-flow-node.source { border-color: var(--cx-focus); background: color-mix(in srgb, var(--cx-focus) 10%, var(--cx-card)); }
  #cx-root .cx-flow-node.c-error { border-color: var(--cx-removed); }
  .cx-carries { display: block; white-space: pre-wrap; word-break: break-word; font-size: 11.5px; }
  .cx-logic-head { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
  .cx-logic-head b { font-size: 13px; }
  .cx-logic-head .where { color: var(--cx-faint); font-family: var(--cx-mono); font-size: 11px; }
  #cx-root .cx-logic-node { position: absolute; left: 0; top: 0; display: grid; place-items: center; padding: .25rem .6rem; border: 1px solid var(--cx-line-strong); border-radius: 6px; background: var(--cx-card); text-align: center; overflow: hidden; }
  .cx-logic-node .text { display: grid; max-width: 100%; position: relative; z-index: 1; }
  .cx-logic-node .text span { font-family: var(--cx-mono); font-size: 11px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #cx-root .cx-logic-node.decision { border: 0; background: none; padding: .2rem 2.6rem; }
  #cx-root .cx-logic-node.decision::before { content: ''; position: absolute; inset: 0; clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); background: var(--cx-modified); }
  #cx-root .cx-logic-node.decision::after { content: ''; position: absolute; inset: 1.5px; clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); background: var(--cx-card); }
  #cx-root .cx-logic-node.loop { border-color: var(--cx-callee); border-radius: 18px; }
  #cx-root .cx-logic-node.term { border-radius: 16px; }
  #cx-root .cx-logic-node.t-return { border-color: var(--cx-added); }
  #cx-root .cx-logic-node.t-throw { border-color: var(--cx-removed); color: var(--cx-removed); }
  #cx-root .cx-logic-node.start, #cx-root .cx-logic-node.end { border-radius: 16px; color: var(--cx-dim); }
  #cx-root .cx-logic-node.t-try { border-style: dashed; }
  .cx-steps { margin: 0; padding: 0; list-style: none; display: grid; gap: .1rem; }
  .cx-steps li { display: flex; align-items: baseline; gap: .4rem; padding: .1rem .3rem; border-radius: 3px; font-size: 12px; }
  .cx-steps li.lit { background: color-mix(in srgb, var(--cx-changed) 16%, transparent); }
  .cx-steps li .w { color: var(--cx-text); font-weight: 600; white-space: nowrap; }
  .cx-steps li code { flex: 1 1 auto; min-width: 0; color: var(--cx-dim); font-size: 11px; white-space: pre-wrap; word-break: break-word; background: none; border: 0; padding: 0; }
  .cx-steps li.decide .w { color: var(--cx-modified); } .cx-steps li.loop .w { color: var(--cx-callee); } .cx-steps li.error .w { color: var(--cx-removed); } .cx-steps li.done .w { color: var(--cx-added); }
  .cx-steps .d1 { padding-left: 1.1rem; } .cx-steps .d2 { padding-left: 2.2rem; } .cx-steps .d3 { padding-left: 3.3rem; } .cx-steps .d4 { padding-left: 4.4rem; } .cx-steps .d5 { padding-left: 5.5rem; } .cx-steps .d6 { padding-left: 6.6rem; }
  #cx-root button.ln { margin-left: auto; flex: none; color: var(--cx-faint); font-family: var(--cx-mono); font-size: 10.5px; }
  #cx-root button.ln:hover:not(:disabled) { color: var(--sf-link, var(--vscode-textLink-foreground)); }
  .cx-reasons li { flex-wrap: wrap; }
  .cx-reasons .why, .cx-links .why { color: var(--cx-faint); font-size: 10.5px; }
  .cx-lens-hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cx-dim); font-size: 11.5px; }
  #cx-root .cx-back { margin-bottom: .4rem; color: var(--sf-link, var(--vscode-textLink-foreground)); font-size: 11.5px; }
`;

/** The static shell. Every dynamic part is filled by the script from the posted model. */
export function codeExplainerBody(token: string): string {
  return `<style nonce="${escape(token)}">${CX_STYLE}</style>
  <div id="cx-root" class="cx" data-loading="true">
    <header class="cx-head">
      <span class="cx-logo" aria-hidden="true">${icon('code', { size: 20 })}</span>
      <div class="cx-heading">
        <h1><span>Code Explainer</span><span id="cx-badges" class="cx-badges"></span></h1>
        <p class="cx-context" id="cx-context"><span>Reading the change and asking the language services…</span></p>
      </div>
      <div class="cx-actions">
        <button class="cx-btn cx-primary" type="button" id="cx-ask" data-action="ask" title="Open Copilot Chat with a prompt about the selected code. You review it before sending.">${icon('skill', { size: 14 })}<span>Ask Copilot</span></button>
        <div class="cx-depth" role="group" aria-label="Call depth"><span>Call depth</span>
          <button type="button" data-depth="1" aria-pressed="true" title="Direct callers and callees">1</button>
          <button type="button" data-depth="2" aria-pressed="false" title="Two calls away">2</button>
          <button type="button" data-depth="3" aria-pressed="false" title="Three calls away">3</button>
        </div>
        <div class="cx-depth cx-view-mode" role="group" aria-label="Graph view"><span>View</span>
          <button type="button" data-view="delta" aria-pressed="true" title="What this Story changed, and the code it calls or is called by">Delta</button>
          <button type="button" data-view="full" aria-pressed="false" title="Every function in the current worktree's code, and how they call each other">Full</button>
        </div>
        <button class="cx-btn" type="button" data-action="reindex" title="Read the change and ask the language services again">${icon('refresh', { size: 14 })}<span>Re-index</span></button>
      </div>
    </header>
    <nav class="cx-lenses" role="tablist" aria-label="Lenses">
      <button class="cx-lens" type="button" role="tab" id="cx-lens-code" data-lens="code" aria-selected="true" aria-controls="cx-tabs-row"><b>Code</b><small>functions and calls</small></button>
      <button class="cx-lens" type="button" role="tab" id="cx-lens-concepts" data-lens="concepts" aria-selected="false" aria-controls="cx-view-concepts" tabindex="-1"><b>Concepts</b><small>what it is about</small></button>
      <button class="cx-lens" type="button" role="tab" id="cx-lens-entities" data-lens="entities" aria-selected="false" aria-controls="cx-view-entities" tabindex="-1"><b>Entities</b><small>the data it holds</small></button>
      <button class="cx-lens" type="button" role="tab" id="cx-lens-flow" data-lens="flow" aria-selected="false" aria-controls="cx-view-flow" tabindex="-1"><b>Data flow</b><small>in, through, out</small></button>
      <button class="cx-lens" type="button" role="tab" id="cx-lens-logic" data-lens="logic" aria-selected="false" aria-controls="cx-view-logic" tabindex="-1"><b>Logic</b><small>steps and decisions</small></button>
    </nav>
    <nav class="cx-tabs" id="cx-tabs-row" role="tablist" aria-label="Explainer views">
      <button class="cx-tab" type="button" role="tab" id="cx-tab-graph" data-tab="graph" aria-selected="true" aria-controls="cx-view-graph">Dependency graph <span class="cx-count" id="cx-count-graph">0</span></button>
      <button class="cx-tab" type="button" role="tab" id="cx-tab-trace" data-tab="trace" aria-selected="false" aria-controls="cx-view-trace" tabindex="-1">Requirement → test trace <span class="cx-count" id="cx-count-trace">0</span></button>
      <button class="cx-tab" type="button" role="tab" id="cx-tab-walk" data-tab="walk" aria-selected="false" aria-controls="cx-view-walk" tabindex="-1">Walkthrough <span class="cx-count" id="cx-count-walk">0</span></button>
      <button class="cx-tab" type="button" role="tab" id="cx-tab-repo" data-tab="repo" aria-selected="false" aria-controls="cx-view-repo" tabindex="-1">Repository <span class="cx-count" id="cx-count-repo"></span></button>
      <div class="cx-legend" aria-hidden="true"><span><i class="cx-dot changed"></i>Changed</span><span><i class="cx-dot caller"></i>Caller</span><span><i class="cx-dot callee"></i>Callee</span><span><i class="cx-dot test"></i>Test</span><span><i class="cx-dot external"></i>External</span></div>
    </nav>
    <div class="cx-main" id="cx-main">
      <aside class="cx-outline" id="cx-outline" aria-label="Changed code outline">
        <div class="cx-tree" id="cx-tree" role="tree" aria-label="Modules and functions"></div>
      </aside>
      <div class="cx-stage">
        <section class="cx-view" id="cx-view-graph" role="tabpanel" aria-labelledby="cx-tab-graph">
          <div class="cx-toolbar">
            <button class="cx-icon-btn" type="button" data-action="outline" aria-pressed="true" title="Show or hide the outline">${icon('collection', { size: 14 })}</button>
            <label class="cx-search">${icon('search', { size: 14 })}<input id="cx-search" type="search" placeholder="Find…  /" aria-label="Find a function" autocomplete="off" spellcheck="false"></label>
            <span class="cx-label">Canvas · <b>layered call layout</b></span>
            <div class="cx-filters" id="cx-filters" role="group" aria-label="Show"></div>
            <span class="cx-spacer"></span>
            <button class="cx-icon-btn" type="button" data-action="isolate" aria-pressed="false" title="Isolate the selection and its neighbours (I)">${icon('capability', { size: 14 })}</button>
            <button class="cx-icon-btn" type="button" data-action="relayout" title="Lay the graph out again (L)">${icon('workflow', { size: 14 })}</button>
            <button class="cx-icon-btn" type="button" data-action="minimap" aria-pressed="true" title="Show or hide the overview (M)">${icon('visual', { size: 14 })}</button>
            <div class="cx-zoom">
              <button class="cx-icon-btn" type="button" data-action="zoom-out" title="Zoom out (-)">−</button>
              <output id="cx-zoom-level">100%</output>
              <button class="cx-icon-btn" type="button" data-action="zoom-in" title="Zoom in (+)">+</button>
              <button class="cx-icon-btn" type="button" data-action="fit" title="Fit to view (F)">${icon('impact', { size: 14 })}</button>
            </div>
          </div>
          <div class="cx-canvas" id="cx-canvas" tabindex="0" role="application" aria-label="Dependency graph. Arrow keys move between functions, Enter opens, Escape clears.">
            <div class="cx-progress" id="cx-progress"></div>
            <div class="cx-world" id="cx-world"><svg class="cx-edges" id="cx-edges" aria-hidden="true"></svg><div id="cx-nodes"></div></div>
            <div class="cx-canvas-note" id="cx-canvas-note" hidden></div>
            <div class="cx-minimap" id="cx-minimap" title="Overview: click to move there"></div>
          </div>
        </section>
        <section class="cx-view" id="cx-view-trace" role="tabpanel" aria-labelledby="cx-tab-trace" hidden>
          <div class="cx-toolbar"><span class="cx-label">Requirements → changed code → tests → recorded results</span><span class="cx-spacer"></span>
            <button class="cx-filter" type="button" data-action="gaps" aria-pressed="false">Only gaps</button></div>
          <div class="cx-trace" id="cx-trace"></div>
        </section>
        <section class="cx-view" id="cx-view-walk" role="tabpanel" aria-labelledby="cx-tab-walk" hidden>
          <div class="cx-toolbar"><span class="cx-label">Read the change in call order · <b>J</b>/<b>K</b> or ←/→ to move</span></div>
          <div class="cx-walk" id="cx-walk"></div>
        </section>
        <section class="cx-view" id="cx-view-repo" role="tabpanel" aria-labelledby="cx-tab-repo" hidden>
          <div class="cx-toolbar"><span class="cx-label" id="cx-repo-scope">What the repository holds</span><span class="cx-spacer"></span>
            <button class="cx-filter" type="button" data-action="repo-up" title="Back to the enclosing folder">Up</button>
            <button class="cx-filter" type="button" data-action="repo-refresh" title="Explain this scope again">Refresh</button></div>
          <div class="cx-repo" id="cx-repo"></div>
        </section>
        <section class="cx-view cx-lens-view" id="cx-view-concepts" role="tabpanel" aria-labelledby="cx-lens-concepts" hidden>
          <div class="cx-toolbar"><span class="cx-lens-hint">How the code is organised, and the words it is about</span></div>
          <div class="cx-lens-body" id="cx-concepts"></div>
        </section>
        <section class="cx-view cx-lens-view" id="cx-view-entities" role="tabpanel" aria-labelledby="cx-lens-entities" hidden>
          <div class="cx-toolbar"><span class="cx-lens-hint">The data it works with: fields, links and who uses them</span></div>
          <div class="cx-lens-body" id="cx-entities"></div>
        </section>
        <section class="cx-view cx-lens-view" id="cx-view-flow" role="tabpanel" aria-labelledby="cx-lens-flow" hidden>
          <div class="cx-toolbar"><span class="cx-label">From</span><select id="cx-flow-entry" class="cx-select" aria-label="Entry point"></select><span class="cx-spacer"></span><span class="cx-lens-hint">each arrow: what the call hands over</span></div>
          <div class="cx-lens-body" id="cx-flow"></div>
        </section>
        <section class="cx-view cx-lens-view" id="cx-view-logic" role="tabpanel" aria-labelledby="cx-lens-logic" hidden>
          <div class="cx-toolbar"><span class="cx-label">Function</span><select id="cx-logic-fn" class="cx-select" aria-label="Function"></select></div>
          <div class="cx-lens-body" id="cx-logic"></div>
        </section>
      </div>
      <div class="cx-splitter" id="cx-splitter" role="separator" aria-orientation="vertical" aria-label="Resize the inspector" tabindex="0"></div>
      <aside class="cx-inspector" id="cx-inspector" aria-label="Inspector" aria-live="polite"></aside>
    </div>
    <footer class="cx-status" id="cx-status"></footer>
  </div>`;
}

/**
 * The page script. A raw string, so regular expressions keep their backslashes; it must never
 * contain a template placeholder or a backtick, and never the closing tag of a script element.
 */
export const CODE_EXPLAINER_SCRIPT = String.raw`
(function () {
  const vscode = window.__sfVscode;
  const SVG = 'http://www.w3.org/2000/svg';
  const CARD_W = 300, HEAD_H = 47, ROW_H = 26, MORE_H = 22, FOOT_H = 0, PAD = 9, GAP_X = 120, GAP_Y = 34, READABLE = 0.62;
  const ROLE_ORDER = { changed: 0, focus: 0, repository: 0, caller: 1, test: 2, callee: 3, external: 4, context: 5, other: 6 };
  const ROLE_LABEL = { changed: 'Changed', focus: 'Focus', repository: 'Repository', caller: 'Caller', callee: 'Callee', test: 'Test', external: 'External', context: 'Context', other: 'Other files' };
  const KIND_MARK = { function: 'ƒ', method: 'm', constructor: 'c', class: 'C', variable: 'v', 'module-scope': '§', removed: '×', file: '▤' };

  // ---- Pure helpers (exposed for tests) ---------------------------------------------------
  function isCollapsed(module, view) {
    const chosen = view.collapsed[module.id];
    return chosen === undefined ? Boolean(module.collapsed) : Boolean(chosen);
  }

  function moduleRows(model, module, view) {
    const ids = module.symbolIds;
    const visible = [];
    const hidden = [];
    for (const id of ids) {
      const symbol = model.byId[id];
      if (!symbol) continue;
      const shown = view.expanded[module.id] || symbol.primary || symbol.id === view.selected;
      (shown ? visible : hidden).push(symbol);
    }
    const limit = view.expanded[module.id] ? Infinity : 12;
    const rows = visible.slice(0, limit);
    const overflow = visible.slice(limit).length + hidden.length;
    const folded = isCollapsed(module, view);
    return { rows: folded ? [] : rows, hidden: folded ? ids.length : overflow };
  }

  function cardHeight(rows, hidden) {
    return HEAD_H + PAD + rows * ROW_H + (hidden ? MORE_H : 0) + FOOT_H + 4;
  }

  /**
   * Layered layout for module cards: callers to the left of what they call. Cycles are broken by
   * reversing the edges a depth-first walk finds going back; layers come from the longest path;
   * order inside a layer from four barycentre sweeps; vertical positions pull each card toward
   * its neighbours without overlapping. Cards with no edges go in a grid after the last layer.
   */
  function layout(nodes, edges) {
    const ids = nodes.map(function (node) { return node.id; });
    const byId = {};
    nodes.forEach(function (node) { byId[node.id] = node; });
    const out = {}, inn = {};
    ids.forEach(function (id) { out[id] = []; inn[id] = []; });
    const seen = {};
    const pairs = [];
    edges.forEach(function (edge) {
      if (edge.from === edge.to || !byId[edge.from] || !byId[edge.to]) return;
      const key = edge.from + '>' + edge.to;
      if (seen[key]) return;
      seen[key] = true;
      pairs.push([edge.from, edge.to]);
    });
    // Break cycles.
    const state = {};
    const order = ids.slice().sort(function (a, b) { return (byId[a].rank0 || 0) - (byId[b].rank0 || 0) || (a < b ? -1 : a > b ? 1 : 0); });
    const adjacency = {};
    ids.forEach(function (id) { adjacency[id] = []; });
    pairs.forEach(function (pair) { adjacency[pair[0]].push(pair[1]); });
    const reversed = {};
    function dfs(id) {
      state[id] = 1;
      adjacency[id].forEach(function (next) {
        if (state[next] === 1) reversed[id + '>' + next] = true;
        else if (!state[next]) dfs(next);
      });
      state[id] = 2;
    }
    order.forEach(function (id) { if (!state[id]) dfs(id); });
    pairs.forEach(function (pair) {
      const flipped = reversed[pair[0] + '>' + pair[1]];
      const from = flipped ? pair[1] : pair[0];
      const to = flipped ? pair[0] : pair[1];
      if (out[from].indexOf(to) < 0) { out[from].push(to); inn[to].push(from); }
    });
    // Longest-path layers.
    const rank = {};
    const indegree = {};
    ids.forEach(function (id) { indegree[id] = inn[id].length; rank[id] = 0; });
    const queue = order.filter(function (id) { return indegree[id] === 0; });
    while (queue.length) {
      const id = queue.shift();
      out[id].forEach(function (next) {
        rank[next] = Math.max(rank[next], rank[id] + 1);
        indegree[next] -= 1;
        if (indegree[next] === 0) queue.push(next);
      });
    }
    const connected = ids.filter(function (id) { return out[id].length || inn[id].length; });
    const isolated = order.filter(function (id) { return !out[id].length && !inn[id].length; });
    const layers = [];
    connected.forEach(function (id) { (layers[rank[id]] = layers[rank[id]] || []).push(id); });
    for (let index = 0; index < layers.length; index += 1) layers[index] = layers[index] || [];
    layers.forEach(function (layer) {
      layer.sort(function (a, b) { return (byId[a].rank0 || 0) - (byId[b].rank0 || 0) || (a < b ? -1 : a > b ? 1 : 0); });
    });
    const position = {};
    function reindex() { layers.forEach(function (layer) { layer.forEach(function (id, index) { position[id] = index; }); }); }
    reindex();
    for (let sweep = 0; sweep < 4; sweep += 1) {
      const down = sweep % 2 === 0;
      const sequence = down ? layers.map(function (_, index) { return index; }) : layers.map(function (_, index) { return layers.length - 1 - index; });
      sequence.forEach(function (index) {
        const layer = layers[index];
        const score = {};
        layer.forEach(function (id) {
          const neighbours = down ? inn[id] : out[id];
          score[id] = neighbours.length ? neighbours.reduce(function (sum, other) { return sum + position[other]; }, 0) / neighbours.length : position[id];
        });
        layer.sort(function (a, b) { return score[a] - score[b] || position[a] - position[b]; });
        layer.forEach(function (id, at) { position[id] = at; });
      });
    }
    // Coordinates.
    const result = {};
    let x = 0;
    layers.forEach(function (layer) {
      let y = 0;
      layer.forEach(function (id) { result[id] = { x: x, y: y }; y += byId[id].height + GAP_Y; });
      const shift = -(y - GAP_Y) / 2;
      layer.forEach(function (id) { result[id].y += shift; });
      x += CARD_W + GAP_X;
    });
    // Pull toward neighbours in the layer before, keeping order and spacing.
    for (let pass = 0; pass < 3; pass += 1) {
      layers.forEach(function (layer, index) {
        if (!index && pass === 0) return;
        const desired = layer.map(function (id) {
          const neighbours = inn[id].concat(out[id]).filter(function (other) { return result[other] && rank[other] !== rank[id]; });
          if (!neighbours.length) return result[id].y;
          const centre = neighbours.reduce(function (sum, other) { return sum + result[other].y + byId[other].height / 2; }, 0) / neighbours.length;
          return centre - byId[id].height / 2;
        });
        layer.forEach(function (id, at) { result[id].y = desired[at]; });
        for (let at = 1; at < layer.length; at += 1) {
          const above = result[layer[at - 1]];
          const minimum = above.y + byId[layer[at - 1]].height + GAP_Y;
          if (result[layer[at]].y < minimum) result[layer[at]].y = minimum;
        }
        for (let at = layer.length - 2; at >= 0; at -= 1) {
          const below = result[layer[at + 1]];
          const maximum = below.y - byId[layer[at]].height - GAP_Y;
          if (result[layer[at]].y > maximum) result[layer[at]].y = Math.max(maximum, at ? result[layer[at - 1]].y + byId[layer[at - 1]].height + GAP_Y : -Infinity);
        }
      });
    }
    // Cards with no call edges: a grid below the connected graph, as wide as it (at least two columns).
    if (isolated.length) {
      let minX = 0, maxY = 0;
      if (connected.length) {
        minX = Infinity; maxY = -Infinity;
        connected.forEach(function (id) { minX = Math.min(minX, result[id].x); maxY = Math.max(maxY, result[id].y + byId[id].height); });
      }
      const width = Math.max(1, layers.length);
      const columns = Math.max(Math.min(2, isolated.length), Math.min(width, isolated.length, 4));
      const tops = [];
      for (let column = 0; column < columns; column += 1) tops.push(connected.length ? maxY + GAP_Y * 2 : 0);
      isolated.forEach(function (id) {
        let column = 0;
        for (let candidate = 1; candidate < columns; candidate += 1) if (tops[candidate] < tops[column]) column = candidate;
        result[id] = { x: minX + column * (CARD_W + GAP_X / 2), y: tops[column] };
        tops[column] += byId[id].height + GAP_Y;
      });
    }
    return { positions: result, reversed: reversed, rank: rank };
  }

  /** A call between two rows of one card: out of the right edge and back into it. */
  function loopPath(x, y1, y2) {
    const bulge = 26 + Math.min(70, Math.abs(y2 - y1) / 4);
    return 'M' + x + ' ' + y1 + ' C' + (x + bulge) + ' ' + y1 + ' ' + (x + bulge) + ' ' + y2 + ' ' + (x + 2) + ' ' + y2;
  }

  /** A cubic path between two ports; a backward edge loops out to the side. */
  function edgePath(x1, y1, x2, y2) {
    if (x2 >= x1 + 30) {
      const dx = Math.max(40, (x2 - x1) / 2);
      return 'M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 + ' ' + x2 + ' ' + y2;
    }
    const loop = 70 + Math.min(120, Math.abs(y2 - y1) / 3);
    return 'M' + x1 + ' ' + y1 + ' C' + (x1 + loop) + ' ' + y1 + ' ' + (x2 - loop) + ' ' + y2 + ' ' + x2 + ' ' + y2;
  }

  function fitTransform(bounds, width, height, margin) {
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return { zoom: 1, x: margin, y: margin };
    const zoom = Math.max(0.2, Math.min(1, (width - margin * 2) / bounds.w, (height - margin * 2) / bounds.h));
    return { zoom: zoom, x: (width - bounds.w * zoom) / 2 - bounds.x * zoom, y: (height - bounds.h * zoom) / 2 - bounds.y * zoom };
  }

  /** The symbols a keyboard arrow moves to from the selection. */
  function neighbour(model, view, direction) {
    const current = model.byId[view.selected];
    if (!current) return null;
    if (direction === 'left') return current.callers.filter(visibleSymbol)[0] || null;
    if (direction === 'right') return current.callees.filter(visibleSymbol)[0] || null;
    const module = model.moduleById[current.moduleId];
    const rows = moduleRows(model, module, view).rows.map(function (symbol) { return symbol.id; });
    const at = rows.indexOf(current.id);
    if (at < 0) return null;
    return rows[at + (direction === 'down' ? 1 : -1)] || null;
  }


  // ---- Logic flowchart layout (pure) --------------------------------------------------------
  // A structured layout: a sequence stacks downwards, a decision puts its branches side by side,
  // a loop draws its body below its head with the way back on the right and the exit on the left.
  // Coordinates are relative to each block while it is built, then shifted into place.
  const LG = { W: 232, LINE: 16, PAD: 9, GAP: 30, LANE: 26, DIAMOND: 58, TERM: 32, HEAD: 38, CASE_GAP: 22 };
  function logicLines(step) {
    if (step.k === 'step') return step.lines.map(function (entry) { return entry.text; });
    if (step.k === 'if') return [step.cond];
    if (step.k === 'loop') return [step.head];
    if (step.k === 'switch') return ['depending on ' + step.subject];
    if (step.k === 'try') return ['try'];
    if (step.k === 'return') return ['return' + (step.text ? ' ' + step.text : '')];
    if (step.k === 'throw') return ['throw ' + step.text];
    return [step.text];
  }
  /** A condition broken onto at most two lines at a space or an operator, so a diamond can show it. */
  function wrapCondition(text, width) {
    if (text.length <= width) return [text];
    let cut = -1;
    for (let at = Math.min(text.length - 1, width); at > width / 2; at -= 1) {
      if (text[at] === ' ' || text[at] === ',') { cut = at; break; }
    }
    if (cut < 0) cut = width;
    const rest = text.slice(cut).trim();
    return [text.slice(0, cut).trim(), rest.length > width ? rest.slice(0, width - 1) + '…' : rest];
  }
  function logicLayout(steps) {
    let next = 0;
    function make(kind, step, lines) {
      if (kind === 'decision' && lines.length === 1) lines = wrapCondition(lines[0], 24);
      const height = kind === 'decision' ? LG.DIAMOND : kind === 'term' || kind === 'start' || kind === 'end' ? LG.TERM
        : kind === 'loop' ? LG.HEAD : LG.PAD * 2 + LG.LINE * Math.max(1, Math.min(4, lines.length));
      const firstLine = step ? (step.line || (step.lines && step.lines[0] ? step.lines[0].line : null)) : null;
      return { id: 'n' + (next++), kind: kind, tone: step ? step.k : kind, lines: lines, line: firstLine || null,
        calls: step && step.calls ? step.calls.slice() : [], x: 0, y: 0, w: kind === 'start' || kind === 'end' ? 90 : LG.W, h: height };
    }
    function shift(block, dx, dy) {
      block.nodes.forEach(function (node) { node.x += dx; node.y += dy; });
      block.edges.forEach(function (edge) { if (edge.rx !== undefined) edge.rx += dx; if (edge.lx !== undefined) edge.lx += dx; if (edge.sx !== undefined) edge.sx += dx; });
      block.outs.forEach(function (out) { if (out.rx !== undefined) out.rx += dx; if (out.lx !== undefined) out.lx += dx; });
      return block;
    }
    function connect(edges, outs, to) {
      outs.forEach(function (out) { edges.push({ from: out.id, to: to, label: out.label || null, rx: out.rx, lx: out.lx, dashed: Boolean(out.dashed) }); });
    }
    function leaf(node, open) { return { w: node.w, h: node.h, nodes: [node], edges: [], first: node.id, outs: open ? [{ id: node.id, label: null }] : [] }; }
    function sequence(list) {
      const blocks = list.map(blockOf);
      const width = blocks.reduce(function (max, block) { return Math.max(max, block.w); }, LG.W);
      let y = 0, first = null, outs = null;
      const nodes = [], edges = [];
      blocks.forEach(function (block) {
        shift(block, (width - block.w) / 2, y);
        if (outs === null) first = block.first; else connect(edges, outs, block.first);
        block.nodes.forEach(function (node) { nodes.push(node); });
        block.edges.forEach(function (edge) { edges.push(edge); });
        outs = block.outs;
        y += block.h + LG.GAP;
      });
      return { w: width, h: Math.max(0, y - LG.GAP), nodes: nodes, edges: edges, first: first, outs: outs || [] };
    }
    function columns(head, branches, labelled) {
      // A head above side-by-side branch blocks; empty branches leave the head open with their label.
      const width = Math.max(LG.W, branches.reduce(function (sum, branch, index) { return sum + branch.block.w + (index ? LG.CASE_GAP : 0); }, 0));
      head.x = (width - head.w) / 2;
      head.y = 0;
      const top = head.h + LG.GAP;
      let x = (width - branches.reduce(function (sum, branch, index) { return sum + branch.block.w + (index ? LG.CASE_GAP : 0); }, 0)) / 2;
      const nodes = [head], edges = [], outs = [];
      let height = 0;
      branches.forEach(function (branch) {
        shift(branch.block, x, top);
        x += branch.block.w + LG.CASE_GAP;
        branch.block.nodes.forEach(function (node) { nodes.push(node); });
        branch.block.edges.forEach(function (edge) { edges.push(edge); });
        if (branch.block.first) {
          edges.push({ from: head.id, to: branch.block.first, label: labelled ? branch.label : null, dashed: Boolean(branch.dashed) });
          branch.block.outs.forEach(function (out) { outs.push(out); });
        } else outs.push({ id: head.id, label: branch.label });
        height = Math.max(height, branch.block.h);
      });
      return { w: width, h: top + height, nodes: nodes, edges: edges, first: head.id, outs: outs };
    }
    function ladder(head, branches) {
      // Many cases: a spine runs down from the decision and each case hangs off it, one under the
      // next, so a long switch grows down the page instead of across it. Open ends leave by a lane
      // on the right.
      head.x = 0;
      head.y = 0;
      const spine = head.w / 2;
      const left = spine + LG.LANE + 12;
      const widest = branches.reduce(function (max, branch) { return Math.max(max, branch.block.w); }, LG.W);
      const width = Math.max(head.w, left + widest) + LG.LANE;
      const lane = width - LG.LANE / 2;
      const nodes = [head], edges = [], outs = [];
      let y = head.h + LG.GAP;
      branches.forEach(function (branch) {
        if (!branch.block.first) {
          outs.push({ id: head.id, label: branch.label, rx: lane });
          return;
        }
        shift(branch.block, left, y);
        branch.block.nodes.forEach(function (node) { nodes.push(node); });
        branch.block.edges.forEach(function (edge) { edges.push(edge); });
        edges.push({ from: head.id, to: branch.block.first, label: branch.label, sx: spine });
        branch.block.outs.forEach(function (out) { outs.push({ id: out.id, label: out.label, rx: lane }); });
        y += branch.block.h + LG.GAP;
      });
      return { w: width, h: Math.max(head.h, y - LG.GAP), nodes: nodes, edges: edges, first: head.id, outs: outs };
    }
    function blockOf(step) {
      if (step.k === 'step') return leaf(make('step', step, step.lines.map(function (entry) { return entry.text; })), true);
      if (step.k === 'return' || step.k === 'throw' || step.k === 'jump') return leaf(make('term', step, logicLines(step)), false);
      if (step.k === 'if') {
        // An else-if chain is one decision with several outcomes: checked in order, the first that holds wins.
        const chain = [step];
        while (chain[chain.length - 1].else && chain[chain.length - 1].else.length === 1 && chain[chain.length - 1].else[0].k === 'if') chain.push(chain[chain.length - 1].else[0]);
        if (chain.length >= 3) {
          const head = make('decision', step, ['first that holds']);
          const tail = chain[chain.length - 1].else;
          const branches = chain.map(function (entry) { return { block: sequence(entry.then), label: entry.cond }; });
          branches.push({ block: sequence(tail || []), label: tail && tail.length ? 'otherwise' : 'none holds' });
          return ladder(head, branches);
        }
        const head = make('decision', step, [step.cond]);
        const yes = sequence(step.then);
        if (step.else && step.else.length) return columns(head, [{ block: yes, label: 'yes' }, { block: sequence(step.else), label: 'no' }], true);
        // No else: "no" goes round the right of the "yes" branch to whatever comes next.
        const block = columns(head, [{ block: yes, label: 'yes' }], true);
        const lane = block.w + LG.LANE / 2;
        block.w += LG.LANE;
        block.outs.push({ id: head.id, label: 'no', rx: lane });
        return block;
      }
      if (step.k === 'switch') {
        const head = make('decision', step, logicLines(step));
        const branches = step.cases.map(function (entry) { return { block: sequence(entry.body), label: entry.label }; });
        return branches.length > 3 ? ladder(head, branches) : columns(head, branches, true);
      }
      if (step.k === 'try') {
        const head = make('step', step, ['try']);
        const branches = [{ block: sequence(step.body), label: null }].concat(step.catches.map(function (entry) {
          return { block: sequence(entry.body), label: 'on error: ' + entry.label, dashed: true };
        }));
        const block = columns(head, branches, true);
        if (step.final && step.final.length) {
          const final = sequence(step.final);
          shift(final, (Math.max(block.w, final.w) - final.w) / 2, block.h + LG.GAP);
          if (final.w > block.w) shift(block, (final.w - block.w) / 2, 0);
          connect(block.edges, block.outs, final.first);
          return { w: Math.max(block.w, final.w), h: block.h + LG.GAP + final.h, nodes: block.nodes.concat(final.nodes),
            edges: block.edges.concat(final.edges), first: block.first, outs: final.outs };
        }
        return block;
      }
      if (step.k === 'loop') {
        const head = make('loop', step, [step.head]);
        const body = sequence(step.body);
        const width = Math.max(LG.W, body.w) + LG.LANE * 2;
        head.x = (width - head.w) / 2;
        shift(body, (width - body.w) / 2, head.h + LG.GAP);
        const nodes = [head].concat(body.nodes);
        const edges = body.edges.slice();
        if (body.first) {
          edges.push({ from: head.id, to: body.first, label: 'each time' });
          body.outs.forEach(function (out) { edges.push({ from: out.id, to: head.id, label: null, back: true, rx: width - LG.LANE / 2 }); });
        }
        return { w: width, h: head.h + LG.GAP + body.h, nodes: nodes, edges: edges, first: head.id, outs: [{ id: head.id, label: 'done', lx: LG.LANE / 2 }] };
      }
      return leaf(make('step', step, logicLines(step)), true);
    }
    const start = make('start', null, ['start']);
    const body = sequence(steps);
    const width = Math.max(body.w, LG.W);
    start.x = (width - start.w) / 2;
    shift(body, (width - body.w) / 2, start.h + LG.GAP);
    const nodes = [start].concat(body.nodes);
    const edges = body.edges.slice();
    if (body.first) edges.push({ from: start.id, to: body.first, label: null });
    let height = start.h + LG.GAP + body.h;
    const open = body.first ? body.outs : [{ id: start.id, label: null }];
    if (open.length) {
      const end = make('end', null, ['end']);
      end.x = (width - end.w) / 2;
      end.y = height + LG.GAP;
      nodes.push(end);
      connect(edges, open, end.id);
      height = end.y + end.h;
    }
    return { nodes: nodes, edges: edges, width: width, height: height };
  }

  /**
   * A top-down layered layout that wraps to the width it is given: what feeds a node sits above it,
   * and a layer with more nodes than fit in one row continues on the next. Nodes carry their sizes;
   * a node with no edges goes after the last layer.
   */
  function stackLayout(nodes, edges, width, options) {
    const gapX = (options && options.gapX) || 36, gapY = (options && options.gapY) || 66;
    const ids = {};
    nodes.forEach(function (node) { ids[node.id] = true; });
    const live = edges.filter(function (edge) { return ids[edge.from] && ids[edge.to] && edge.from !== edge.to; });
    const ranks = layout(nodes.map(function (node) { return { id: node.id, height: 1, rank0: node.rank0 || 0 }; }), live).rank;
    const connected = {};
    live.forEach(function (edge) { connected[edge.from] = true; connected[edge.to] = true; });
    let last = 0;
    nodes.forEach(function (node) { if (connected[node.id]) last = Math.max(last, ranks[node.id] || 0); });
    const byRank = {};
    nodes.forEach(function (node) {
      const rank = connected[node.id] ? (ranks[node.id] || 0) : last + 1;
      (byRank[rank] = byRank[rank] || []).push(node);
    });
    const positions = {};
    let y = 0, used = 0;
    Object.keys(byRank).map(Number).sort(function (a, b) { return a - b; }).forEach(function (rank) {
      // Under what feeds them: order a layer by where its predecessors already sit.
      const row = byRank[rank].map(function (node, at) {
        const above = live.filter(function (edge) { return edge.to === node.id && positions[edge.from]; })
          .map(function (edge) { return positions[edge.from].x + positions[edge.from].w / 2; });
        return { node: node, key: above.length ? above.reduce(function (sum, x) { return sum + x; }, 0) / above.length : Infinity, at: at };
      }).sort(function (a, b) { return a.key - b.key || a.at - b.at; }).map(function (entry) { return entry.node; });
      let start = 0;
      while (start < row.length) {
        let span = 0, count = 0;
        while (start + count < row.length && (count === 0 || span + gapX + row[start + count].w <= width)) {
          span += (count ? gapX : 0) + row[start + count].w;
          count += 1;
        }
        const slice = row.slice(start, start + count);
        let x = Math.max(0, (width - span) / 2);
        slice.forEach(function (node) { positions[node.id] = { x: x, y: y, w: node.w, h: node.h }; x += node.w + gapX; });
        used = Math.max(used, span);
        y += Math.max.apply(null, slice.map(function (node) { return node.h; })) + gapY;
        start += count;
      }
    });
    return { positions: positions, width: Math.max(width, used), height: Math.max(0, y - gapY) };
  }

  /** The points of one flowchart edge: down and across, round a lane, or back up to a loop head. */
  function logicRoute(edge, from, to) {
    const fx = from.x + from.w / 2, fy = from.y + from.h, tx = to.x + to.w / 2, ty = to.y;
    if (edge.sx !== undefined) {
      const my = to.y + Math.min(to.h / 2, 18);
      return [[edge.sx, fy], [edge.sx, my], [to.x, my]];
    }
    if (edge.back) {
      const hy = to.y + to.h / 2;
      return [[fx, fy], [fx, fy + 12], [edge.rx, fy + 12], [edge.rx, hy], [to.x + to.w, hy]];
    }
    if (edge.rx !== undefined) {
      const sx = from.kind === 'decision' ? from.x + from.w : fx, sy = from.kind === 'decision' ? from.y + from.h / 2 : fy;
      return [[sx, sy], [edge.rx, sy], [edge.rx, ty - 14], [tx, ty - 14], [tx, ty]];
    }
    if (edge.lx !== undefined) {
      const sy = from.y + from.h / 2;
      return [[from.x, sy], [edge.lx, sy], [edge.lx, ty - 14], [tx, ty - 14], [tx, ty]];
    }
    return [[fx, fy], [fx, ty - 14], [tx, ty - 14], [tx, ty]];
  }

  window.__codeExplainer = { layout: layout, edgePath: edgePath, loopPath: loopPath, fitTransform: fitTransform, moduleRows: moduleRows, cardHeight: cardHeight, isCollapsed: isCollapsed, logicLayout: logicLayout, logicRoute: logicRoute, stackLayout: stackLayout };
  if (!vscode || typeof document === 'undefined' || !document.getElementById('cx-root')) return;

  // ---- State -------------------------------------------------------------------------------
  const root = document.getElementById('cx-root');
  const saved = (vscode.getState && vscode.getState()) || {};
  const DEFAULT_FILTERS = { changed: true, focus: true, repository: true, caller: true, callee: true, test: true, external: false, context: true, other: true };
  const view = Object.assign({
    tab: 'graph', zoom: 1, x: 40, y: 40, selected: null, selectedModule: null, selectedEdge: null, manual: {},
    collapsed: {}, expanded: {}, filters: Object.assign({}, DEFAULT_FILTERS),
    isolate: false, outline: null, minimap: true, inspectorWidth: null, gapsOnly: false, walk: 0, fitted: false, modelId: null, query: '',
    lens: 'code', lensItem: null, flowEntry: null, logicSymbol: null
  }, saved.view || {});
  // Saved filters predate any role added since; a new role starts at its default instead of hidden.
  view.filters = Object.assign({}, DEFAULT_FILTERS, view.filters || {});
  // First open: the outline and a wide inspector only when the panel has room for them.
  if (view.outline === null) view.outline = window.innerWidth >= 1280;
  if (view.inspectorWidth === null) view.inspectorWidth = window.innerWidth >= 1400 ? 380 : 320;
  let model = null;
  // Set once a person picks Delta or Full; from then on the page stays where they asked to look.
  let viewChosen = false;
  let positions = {};
  let progress = null;
  let stale = false;
  let notice = null;
  let noticeTimer = null;
  let request = 0;
  let matches = [];
  let matchAt = -1;
  let hover = null;

  const $ = function (id) { return document.getElementById(id); };
  const canvas = $('cx-canvas'), world = $('cx-world'), edgesLayer = $('cx-edges'), nodesLayer = $('cx-nodes');
  const inspector = $('cx-inspector'), tree = $('cx-tree'), search = $('cx-search');

  function save() {
    vscode.setState({ view: view });
  }
  function post(type, extra) {
    if (!model) return;
    request += 1;
    vscode.postMessage(Object.assign({ type: type, model: model.id, request: request }, extra || {}));
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function svg(tag, attributes) {
    const node = document.createElementNS(SVG, tag);
    for (const key in attributes) node.setAttribute(key, String(attributes[key]));
    return node;
  }
  function button(className, text, onClick, title) {
    const node = el('button', className, text);
    node.type = 'button';
    if (title) node.title = title;
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }
  function chip(text, tone) { return el('span', 'cx-chip ' + (tone || 'dim'), text); }
  function delta(added, removed) {
    const span = el('span', 'cx-delta');
    if (added) span.appendChild(el('span', 'add', '+' + added));
    if (added && removed) span.appendChild(document.createTextNode(' '));
    if (removed) span.appendChild(el('span', 'del', '−' + removed));
    return span;
  }
  function short(value) { return value ? String(value).slice(0, 7) : '—'; }
  function visibleSymbol(id) {
    const symbol = model && model.byId[id];
    if (!symbol) return false;
    const module = model.moduleById[symbol.moduleId];
    return Boolean(module && positions[module.id] && moduleVisible(module));
  }

  // ---- Model -------------------------------------------------------------------------------
  function index(next) {
    next.byId = {};
    next.moduleById = {};
    next.symbols.forEach(function (symbol) { next.byId[symbol.id] = symbol; });
    next.modules.forEach(function (module) { next.moduleById[module.id] = module; });
    return next;
  }

  function moduleVisible(module) {
    if (!view.filters[module.role]) return false;
    if (view.isolate && view.selected && model.byId[view.selected]) {
      const keep = isolationSet();
      return module.symbolIds.some(function (id) { return keep[id]; });
    }
    return true;
  }

  function isolationSet() {
    const keep = {};
    const selected = model.byId[view.selected];
    if (!selected) return keep;
    keep[selected.id] = true;
    const walk = function (id, key, depth) {
      if (depth > 3) return;
      (model.byId[id][key] || []).forEach(function (next) { if (!keep[next]) { keep[next] = true; walk(next, key, depth + 1); } });
    };
    walk(selected.id, 'callers', 1);
    walk(selected.id, 'callees', 1);
    return keep;
  }

  // ---- Header and status -------------------------------------------------------------------
  function renderHead() {
    const badges = $('cx-badges');
    badges.replaceChildren();
    const languages = model.intelligence.languages;
    const live = languages.some(function (entry) { return entry.symbols === 'language-service'; });
    const text = languages.some(function (entry) { return entry.symbols === 'text'; });
    badges.appendChild(chip(live ? 'Live language service' : text ? 'Text outline' : 'File level', live ? 'ok' : 'dim'));
    if (model.story) badges.appendChild(chip('Story ' + model.story.workId, 'info'));
    if (model.view === 'full') badges.appendChild(chip('Full worktree', 'info'));
    else if (model.mode === 'source') badges.appendChild(chip('Source', 'dim'));
    if (model.intelligence.status === 'pending') badges.appendChild(chip('Indexing…', 'warn'));
    const context = $('cx-context');
    context.replaceChildren();
    const item = function (iconText, label, value) {
      const span = el('span');
      if (iconText) span.appendChild(el('span', '', iconText));
      if (label) span.appendChild(document.createTextNode(label + ' '));
      if (value !== undefined) span.appendChild(el('strong', '', value));
      context.appendChild(span);
    };
    item('⑂', '', model.repository.branch || model.repository.name);
    item('◦', 'head', short(model.repository.head));
    if (model.repository.base) item('◦', 'base', short(model.repository.base));
    if (model.story) {
      const story = model.story;
      if (story.gates) {
        const gates = el('span');
        gates.title = story.gates.unmet + ' unmet, ' + (story.gates.outstanding - story.gates.unmet) + ' not evaluated';
        gates.appendChild(el('i', 'gate-dot' + (story.gates.unmet ? ' warn' : '')));
        gates.appendChild(el('strong', '', story.gates.met + '/' + story.gates.total));
        gates.appendChild(document.createTextNode(' gates met'));
        context.appendChild(gates);
      }
      if (story.phaseLabel) item('', 'phase', story.phaseLabel + (story.phases.index ? ' (' + story.phases.index + ' of ' + story.phases.total + ')' : '') + (story.phaseStatus ? ' · ' + story.phaseStatus.replace(/_/g, ' ') : ''));
    }
    if (model.change.status === 'available') item('', '', model.change.codeFiles + ' code files of ' + model.change.files + ' changed · ' + model.change.symbols + ' changed symbols');
    $('cx-ask').hidden = !model.modelEnabled;
    root.querySelectorAll('[data-depth]').forEach(function (node) { node.setAttribute('aria-pressed', String(Number(node.dataset.depth) === model.intelligence.depth)); });
    root.querySelectorAll('[data-view]').forEach(function (node) { node.setAttribute('aria-pressed', String(node.dataset.view === model.view)); });
    $('cx-count-graph').textContent = String(model.modules.filter(function (module) { return module.role !== 'context' || module.symbolIds.length; }).length);
    $('cx-count-trace').textContent = String(model.trace.counts.requirements || model.trace.code.length);
    $('cx-count-walk').textContent = String(model.walkthrough.length);
  }

  function renderStatus() {
    const status = $('cx-status');
    status.replaceChildren();
    const seg = function (text, tone) { const span = el('span', 'seg' + (tone ? ' ' + tone : ''), text); status.appendChild(span); return span; };
    if (progress) seg('◌ ' + progress, 'warn');
    else if (model) seg('● ' + model.change.files + ' changed files · ' + model.change.symbols + ' changed symbols · ' + model.edges.length + ' calls', 'ok');
    if (model) {
      const engines = model.intelligence.languages.map(function (entry) {
        return entry.language + (entry.calls === 'available' ? ' (calls)' : entry.symbols === 'language-service' ? ' (symbols)' : entry.symbols === 'text' ? ' (text outline)' : ' (file level)');
      });
      const engine = button('cx-attn cx-engine', 'ⓘ engine: ' + (engines.length ? engines.join(', ') : 'no code files'), function () { toggleBuildInfo(); }, 'How this view was built');
      status.appendChild(engine);
      if (model.intelligence.durationMs !== null) seg('indexed in ' + (model.intelligence.durationMs / 1000).toFixed(1) + ' s');
      if (model.repository.base) seg('baseline ' + short(model.repository.base));
      if (model.attention.length) {
        const pressing = model.attention.filter(function (group) { return group.category === 'blocker' || group.category === 'missing-explanation'; })
          .reduce(function (sum, group) { return sum + group.count; }, 0);
        const notes = model.attention.reduce(function (sum, group) { return sum + group.count; }, 0) - pressing;
        const label = pressing ? '⚠ ' + pressing + ' to check' + (notes ? ' · ' + notes + ' notes' : '') : 'ⓘ ' + notes + ' notes';
        const attention = button('cx-attn' + (pressing ? '' : ' quiet'), label, function () { toggleAttention(); }, 'What the change view could not explain');
        status.appendChild(attention);
      }
      if (stale) {
        const span = el('span', 'seg warn cx-stale');
        span.appendChild(document.createTextNode('The repository changed since this view was built.'));
        span.appendChild(button('cx-btn', 'Refresh', function () { post('cx.reindex'); }));
        status.appendChild(span);
      }
    }
    const buttons = el('div', 'cx-btns');
    buttons.appendChild(button('cx-btn', 'Export JSON', function () { post('cx.export'); }, 'Save this explanation as JSON'));
    buttons.appendChild(button('cx-btn', 'Change Explorer', function () { post('cx.changeExplorer', { symbol: view.selected }); }, 'Open the evidence view of this change'));
    if (model && model.story) {
      const approvals = model.story.approval;
      buttons.appendChild(button('cx-btn' + (approvals && !approvals.met ? ' cx-primary' : ''), approvals && !approvals.met ? 'Review approval' : 'Story journey',
        function () { post('cx.story', { to: approvals && !approvals.met ? 'approvals' : 'journey' }); },
        approvals ? approvals.distinct + ' of ' + approvals.minimum + ' approvals' : 'Phases and approvals'));
    }
    status.appendChild(buttons);
  }

  function toggleBuildInfo() {
    const existing = root.querySelector('.cx-popover');
    if (existing) { const same = existing.dataset.kind === 'build'; existing.remove(); if (same) return; }
    const pop = el('div', 'cx-popover');
    pop.dataset.kind = 'build';
    pop.setAttribute('role', 'dialog');
    pop.appendChild(el('h3', '', 'How this view was built'));
    const list = el('ul');
    const add = function (text) { list.appendChild(el('li', '', text)); };
    model.intelligence.languages.forEach(function (entry) {
      add(entry.language + ': ' + entry.files + ' file' + (entry.files === 1 ? '' : 's') + ', symbols from ' + (entry.symbols === 'language-service' ? 'the language service' : entry.symbols === 'text' ? 'its own text (no language service answered)' : 'nothing (file level only)')
        + ', calls ' + (entry.calls === 'available' ? 'from its call hierarchy' : entry.calls));
    });
    add('Call depth ' + model.intelligence.depth + '. Change: ' + (model.change.status === 'available' ? model.change.files + ' files against ' + short(model.repository.base) : (model.change.reason || model.change.status)) + '.');
    model.intelligence.notes.forEach(add);
    model.intelligence.truncated.forEach(function (text) { add('Bounded: ' + text + '.'); });
    pop.appendChild(list);
    root.appendChild(pop);
  }

  function toggleAttention() {
    const existing = root.querySelector('.cx-popover');
    if (existing) { const same = existing.dataset.kind === 'attention'; existing.remove(); if (same) return; }
    const pop = el('div', 'cx-popover');
    pop.dataset.kind = 'attention';
    pop.setAttribute('role', 'dialog');
    pop.appendChild(el('h3', '', 'What the change view could not explain'));
    const list = el('ul');
    model.attention.forEach(function (entry) {
      const li = el('li');
      li.appendChild(el('strong', '', entry.label + (entry.count > 1 ? ' ×' + entry.count : '') + ': '));
      li.appendChild(document.createTextNode(entry.text + (entry.count > 1 ? ' (and ' + (entry.count - 1) + ' more like this)' : '')));
      list.appendChild(li);
    });
    pop.appendChild(list);
    root.appendChild(pop);
  }

  function showNotice(text, tone) {
    notice = { text: text, tone: tone || 'info' };
    const existing = root.querySelector('.cx-notice');
    if (existing) existing.remove();
    const node = el('div', 'cx-notice ' + (tone || ''), text);
    node.setAttribute('role', 'status');
    $('cx-view-graph').appendChild(node);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { node.remove(); notice = null; }, 6000);
  }

  // ---- Outline -----------------------------------------------------------------------------
  function renderOutline() {
    tree.replaceChildren();
    const query = view.query.trim().toLowerCase();
    const groups = model.modules.filter(function (module) {
      return module.role !== 'context' || module.symbolIds.some(function (id) { return model.byId[id].status !== 'unchanged'; });
    }).sort(function (a, b) { return (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || (a.path < b.path ? -1 : 1); });
    let shown = 0;
    groups.forEach(function (module) {
      const symbols = module.symbolIds.map(function (id) { return model.byId[id]; }).filter(function (symbol) {
        return symbol.primary || symbol.status !== 'unchanged';
      }).filter(function (symbol) { return !query || symbol.qualifiedName.toLowerCase().indexOf(query) >= 0 || module.path.toLowerCase().indexOf(query) >= 0; });
      if (query && !symbols.length) return;
      const group = el('div', 'cx-tree-group');
      const head = button('cx-tree-module', '', function () { selectModule(module.id, true); });
      head.setAttribute('role', 'treeitem');
      head.appendChild(el('i', 'cx-dot ' + module.role));
      head.appendChild(el('span', 'nm', module.external ? (module.label || module.name) : module.path));
      if (module.added || module.removed) head.appendChild(delta(module.added, module.removed));
      group.appendChild(head);
      symbols.forEach(function (symbol) {
        const row = button('cx-tree-symbol' + (symbol.id === view.selected ? ' selected' : ''), '', function () { select(symbol.id, true); });
        row.setAttribute('role', 'treeitem');
        row.appendChild(el('i', 'cx-dot ' + symbol.role));
        row.appendChild(el('span', 'nm', symbol.qualifiedName));
        if (symbol.added || symbol.removed) row.appendChild(delta(symbol.added, symbol.removed));
        group.appendChild(row);
        shown += 1;
      });
      tree.appendChild(group);
    });
    if (!shown && !groups.length) tree.appendChild(el('div', 'cx-tree-empty', 'Nothing to list yet.'));
    else if (query && !tree.children.length) tree.appendChild(el('div', 'cx-tree-empty', 'No function matches “' + view.query + '”.'));
  }

  // ---- Graph -------------------------------------------------------------------------------
  function renderFilters() {
    const holder = $('cx-filters');
    holder.replaceChildren();
    const counts = {};
    model.modules.forEach(function (module) { counts[module.role] = (counts[module.role] || 0) + 1; });
    ['changed', 'focus', 'repository', 'caller', 'callee', 'test', 'external', 'other', 'context'].forEach(function (role) {
      if (!counts[role]) return;
      const chipButton = button('cx-filter', '', function () {
        view.filters[role] = !view.filters[role];
        save();
        renderGraph(true);
        renderFilters();
      }, (view.filters[role] ? 'Hide ' : 'Show ') + ROLE_LABEL[role].toLowerCase());
      chipButton.setAttribute('aria-pressed', String(Boolean(view.filters[role])));
      chipButton.appendChild(el('i', 'cx-dot ' + role));
      chipButton.appendChild(document.createTextNode(ROLE_LABEL[role]));
      chipButton.appendChild(el('span', 'n', ' ' + counts[role]));
      holder.appendChild(chipButton);
    });
  }

  function visibleModules() {
    return model.modules.filter(function (module) {
      if (!moduleVisible(module)) return false;
      if (module.role === 'context') return module.symbolIds.some(function (id) { return model.byId[id].primary; });
      return module.symbolIds.length > 0;
    });
  }

  function computeLayout() {
    const modules = visibleModules();
    const nodes = modules.map(function (module) {
      const rows = moduleRows(model, module, view);
      return { id: module.id, height: cardHeight(rows.rows.length, rows.hidden), rank0: ROLE_ORDER[module.role] };
    });
    const moduleOf = {};
    model.symbols.forEach(function (symbol) { moduleOf[symbol.id] = symbol.moduleId; });
    const edges = model.edges.map(function (edge) { return { from: moduleOf[edge.from], to: moduleOf[edge.to] }; });
    const result = layout(nodes, edges);
    positions = {};
    nodes.forEach(function (node) {
      const manual = view.manual[node.id];
      const auto = result.positions[node.id] || { x: 0, y: 0 };
      positions[node.id] = { x: manual ? manual.x : auto.x, y: manual ? manual.y : auto.y, h: node.height };
    });
  }

  function bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    Object.keys(positions).forEach(function (id) {
      const p = positions[id];
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + CARD_W); maxY = Math.max(maxY, p.y + p.h);
    });
    return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function applyTransform() {
    world.style.transform = 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.zoom + ')';
    $('cx-zoom-level').textContent = Math.round(view.zoom * 100) + '%';
    renderMinimap();
  }

  function fit() {
    const rect = canvas.getBoundingClientRect();
    const transform = fitTransform(bounds(), rect.width, rect.height, 36);
    view.zoom = transform.zoom; view.x = transform.x; view.y = transform.y;
    applyTransform();
    save();
  }

  /** The first view of a build: everything if it fits readably, otherwise the selection at 80%. */
  function frame() {
    const rect = canvas.getBoundingClientRect();
    const transform = fitTransform(bounds(), rect.width, rect.height, 36);
    if (transform.zoom >= READABLE) { fit(); return; }
    const symbol = model.byId[view.selected];
    const moduleId = symbol ? symbol.moduleId : (model.modules.find(function (module) { return module.role === 'changed' && positions[module.id]; }) || {}).id;
    const p = moduleId && positions[moduleId];
    if (!p) { fit(); return; }
    view.zoom = 0.8;
    view.x = rect.width / 2 - (p.x + CARD_W / 2) * view.zoom;
    view.y = Math.min(36, rect.height / 2 - (p.y + p.h / 2) * view.zoom);
    if (p.y * view.zoom + view.y < 24) view.y = 24 - p.y * view.zoom;
    applyTransform();
    save();
  }

  function zoomAt(factor, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX === undefined ? rect.width / 2 : clientX - rect.left);
    const py = (clientY === undefined ? rect.height / 2 : clientY - rect.top);
    const next = Math.max(0.2, Math.min(2.5, view.zoom * factor));
    view.x = px - (px - view.x) * (next / view.zoom);
    view.y = py - (py - view.y) * (next / view.zoom);
    view.zoom = next;
    applyTransform();
    save();
  }

  function centreOn(moduleId, rowIndex) {
    const p = positions[moduleId];
    if (!p) return;
    const rect = canvas.getBoundingClientRect();
    const targetY = p.y + (rowIndex === undefined ? p.h / 2 : HEAD_H + PAD / 2 + rowIndex * ROW_H + ROW_H / 2);
    const sx = view.x + (p.x + CARD_W / 2) * view.zoom;
    const sy = view.y + targetY * view.zoom;
    const inside = sx > 80 && sx < rect.width - 80 && sy > 60 && sy < rect.height - 60;
    if (inside) return;
    view.x = rect.width / 2 - (p.x + CARD_W / 2) * view.zoom;
    view.y = rect.height / 2 - targetY * view.zoom;
    world.style.transition = 'transform .35s ease';
    applyTransform();
    setTimeout(function () { world.style.transition = ''; }, 380);
    save();
  }

  function rowPort(symbolId, side) {
    const symbol = model.byId[symbolId];
    if (!symbol) return null;
    const p = positions[symbol.moduleId];
    if (!p) return null;
    const module = model.moduleById[symbol.moduleId];
    const rows = moduleRows(model, module, view).rows;
    const at = rows.findIndex(function (row) { return row.id === symbolId; });
    const y = at < 0 ? p.y + HEAD_H / 2 : p.y + HEAD_H + PAD / 2 + at * ROW_H + ROW_H / 2;
    return { x: side === 'out' ? p.x + CARD_W : p.x, y: y };
  }

  function renderNodes() {
    nodesLayer.replaceChildren();
    const query = view.query.trim().toLowerCase();
    matches = [];
    const isolation = view.isolate && view.selected ? isolationSet() : null;
    const related = relatedTo(view.selected);
    visibleModules().forEach(function (module) {
      const p = positions[module.id];
      if (!p) return;
      const folded = isCollapsed(module, view);
      const card = el('div', 'cx-node ' + module.role + (module.id === view.selectedModule ? ' selected-module' : ''));
      card.dataset.module = module.id;
      card.style.transform = 'translate(' + p.x + 'px, ' + p.y + 'px)';
      const head = el('div', 'cx-node-head');
      head.dataset.drag = module.id;
      head.appendChild(el('span', 'cx-dot ' + module.role));
      const file = el('div', 'file');
      file.appendChild(el('b', '', module.external ? (module.label || module.name) : module.name));
      file.appendChild(el('small', '', module.external ? 'outside this repository' : module.group ? module.symbolIds.length + ' file' + (module.symbolIds.length === 1 ? '' : 's') + ' · no symbols' : (module.dir || '.') + '/'));
      head.appendChild(file);
      const right = el('span', 'cx-delta');
      if (module.added || module.removed) right.appendChild(delta(module.added, module.removed));
      head.appendChild(right);
      const roleTag = el('span', 'cx-role ' + module.role, module.group ? 'Files' : module.status === 'added' ? 'New' : module.status === 'deleted' ? 'Deleted' : ROLE_LABEL[module.role]);
      roleTag.title = module.language + ' · ' + module.status + (module.symbolSource === 'none' && module.symbolReason ? ' · ' + module.symbolReason : '');
      head.appendChild(roleTag);
      card.appendChild(head);
      head.addEventListener('click', function (event) {
        if (event.target.closest('button')) return;
        if (head.dataset.moved === '1') { head.dataset.moved = ''; return; }
        selectModule(module.id, false);
      });
      const rowsInfo = moduleRows(model, module, view);
      const rows = el('div', 'cx-rows');
      rowsInfo.rows.forEach(function (symbol) {
        const classes = ['cx-row', symbol.status, 'k-' + symbol.kind];
        if (symbol.id === view.selected) classes.push('selected');
        if (related.callers[symbol.id]) classes.push('related');
        if (related.callees[symbol.id]) classes.push('related', 'out');
        if (isolation && !isolation[symbol.id]) classes.push('dim');
        const isMatch = query && symbol.qualifiedName.toLowerCase().indexOf(query) >= 0;
        if (isMatch) { classes.push('match'); matches.push(symbol.id); }
        const row = button(classes.join(' '), '', null);
        row.dataset.symbol = symbol.id;
        row.setAttribute('aria-label', symbol.qualifiedName + ', ' + symbol.kind + ', ' + symbol.status);
        const kind = el('span', 'kind k-' + symbol.kind, KIND_MARK[symbol.kind] || '•');
        row.appendChild(kind);
        row.appendChild(el('span', 'nm', symbol.qualifiedName + (symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'constructor' ? '()' : '')));
        const meta = el('span', 'meta');
        if (symbol.tests.length) { const tag = el('span', 'cx-tag t-test', 'TEST ' + symbol.tests.length); tag.title = 'Test files that refer to it'; meta.appendChild(tag); }
        if (symbol.tags.length) { const tag = el('span', 'cx-tag t-req', 'REQ'); tag.title = 'Its @clause comment names ' + symbol.tags.map(function (entry) { return entry.clause; }).join(', '); meta.appendChild(tag); }
        else if (symbol.clauses.length && symbol.status !== 'unchanged') { const tag = el('span', 'cx-tag t-req', 'REQ'); tag.title = 'Requirement associated with this file\'s change'; meta.appendChild(tag); }
        if (symbol.status === 'added') meta.appendChild(el('span', 'cx-tag t-new', 'NEW'));
        if (symbol.status === 'removed') meta.appendChild(el('span', 'cx-tag t-gone', 'GONE'));
        if (symbol.added || symbol.removed) meta.appendChild(delta(symbol.added, symbol.removed));
        else if (symbol.line) meta.appendChild(el('span', '', 'L' + symbol.line));
        row.appendChild(meta);
        rows.appendChild(row);
      });
      if (rowsInfo.hidden) {
        const more = button('cx-more', folded ? rowsInfo.hidden + ' folded · show' : view.expanded[module.id] ? 'Show fewer' : '+ ' + rowsInfo.hidden + ' more', function () {
          if (folded) view.collapsed[module.id] = false;
          else view.expanded[module.id] = !view.expanded[module.id];
          save();
          renderGraph(true);
        });
        rows.appendChild(more);
      }
      card.appendChild(rows);
      const collapse = button('cx-collapse', folded ? '▸' : '▾', function () {
        view.collapsed[module.id] = !folded;
        save();
        renderGraph(true);
      }, folded ? 'Expand' : 'Collapse');
      head.appendChild(collapse);
      nodesLayer.appendChild(card);
    });
    if (query) { matchAt = Math.min(matchAt, matches.length - 1); }
  }

  function relatedTo(symbolId) {
    const result = { callers: {}, callees: {} };
    const symbol = model && model.byId[symbolId];
    if (!symbol) return result;
    symbol.callers.forEach(function (id) { result.callers[id] = true; });
    symbol.callees.forEach(function (id) { result.callees[id] = true; });
    return result;
  }

  function ensureDefs() {
    const defs = svg('defs', {});
    [['cx-arrow', ''], ['cx-arrow-active', 'active'], ['cx-arrow-in', 'in'], ['cx-arrow-out', 'out']].forEach(function (entry) {
      const marker = svg('marker', { id: entry[0], viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      if (entry[1]) marker.setAttribute('class', entry[1]);
      marker.appendChild(svg('path', { d: 'M0 0 L10 5 L0 10 z' }));
      defs.appendChild(marker);
    });
    return defs;
  }

  function renderEdges() {
    edgesLayer.replaceChildren(ensureDefs());
    const b = bounds();
    if (b) {
      edgesLayer.setAttribute('width', String(Math.max(1, b.x + b.w + 400)));
      edgesLayer.setAttribute('height', String(Math.max(1, b.y + b.h + 400)));
      edgesLayer.style.left = '0px'; edgesLayer.style.top = '0px';
      edgesLayer.style.overflow = 'visible';
    }
    const selected = view.selected;
    const hovered = hover;
    const focusId = hovered || selected;
    const isolation = view.isolate && selected ? isolationSet() : null;
    model.edges.forEach(function (edge) {
      if (!visibleSymbol(edge.from) || !visibleSymbol(edge.to)) return;
      if (isolation && (!isolation[edge.from] || !isolation[edge.to])) return;
      const from = rowPort(edge.from, 'out');
      const sameCard = model.byId[edge.from].moduleId === model.byId[edge.to].moduleId;
      const to = rowPort(edge.to, sameCard ? 'out' : 'in');
      if (!from || !to) return;
      const d = sameCard ? loopPath(from.x, from.y, to.y) : edgePath(from.x, from.y, to.x, to.y);
      const back = !sameCard && to.x < from.x + 30;
      const touches = focusId && (edge.from === focusId || edge.to === focusId);
      const classes = ['edge'];
      if (back) classes.push('back');
      if (touches) classes.push('active', edge.to === focusId ? 'in' : 'out', 'flow');
      else if (view.selectedEdge === edge.id) classes.push('active', 'flow');
      else if (focusId) classes.push('dim');
      const path = svg('path', { d: d, class: classes.join(' '), 'marker-end': 'url(#' + (touches ? (edge.to === focusId ? 'cx-arrow-in' : 'cx-arrow-out') : view.selectedEdge === edge.id ? 'cx-arrow-active' : 'cx-arrow') + ')' });
      edgesLayer.appendChild(path);
      const hit = svg('path', { d: d, class: 'hit' });
      hit.dataset.edge = edge.id;
      const title = svg('title', {});
      title.textContent = model.byId[edge.from].qualifiedName + ' → ' + model.byId[edge.to].qualifiedName + (edge.sites.length ? ' · ' + edge.sites.length + ' call site' + (edge.sites.length === 1 ? '' : 's') : '');
      hit.appendChild(title);
      edgesLayer.appendChild(hit);
      if ((touches || view.selectedEdge === edge.id) && edge.sites.length > 1) {
        const label = svg('text', { x: sameCard ? from.x + 30 : (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 5, 'text-anchor': 'middle', class: 'edge-label' });
        label.textContent = '×' + edge.sites.length;
        edgesLayer.appendChild(label);
      }
    });
  }

  function renderMinimap() {
    const holder = $('cx-minimap');
    if (!model) return;
    const b = bounds();
    const canvasWidth = canvas.getBoundingClientRect().width;
    holder.hidden = !b || view.tab !== 'graph' || !view.minimap || canvasWidth < 560;
    if (!b) return;
    const pad = 40;
    const box = svg('svg', { viewBox: (b.x - pad) + ' ' + (b.y - pad) + ' ' + (b.w + pad * 2) + ' ' + (b.h + pad * 2), preserveAspectRatio: 'xMidYMid meet' });
    Object.keys(positions).forEach(function (id) {
      const p = positions[id];
      const module = model.moduleById[id];
      box.appendChild(svg('rect', { x: p.x, y: p.y, width: CARD_W, height: p.h, rx: 8, class: 'mm-node ' + (module ? module.role : '') }));
    });
    const rect = canvas.getBoundingClientRect();
    box.appendChild(svg('rect', { x: -view.x / view.zoom, y: -view.y / view.zoom, width: rect.width / view.zoom, height: rect.height / view.zoom, class: 'mm-view' }));
    holder.replaceChildren(box);
  }

  function renderGraph(relayout) {
    if (!model) return;
    if (relayout || !Object.keys(positions).length) computeLayout();
    renderNodes();
    renderEdges();
    if (!view.fitted && Object.keys(positions).length && canvas.getBoundingClientRect().width > 0) { frame(); view.fitted = true; save(); }
    const note = $('cx-canvas-note');
    const modules = visibleModules();
    const anyCalls = model.intelligence.languages.some(function (entry) { return entry.calls === 'available'; });
    const lines = [];
    if (!modules.length) {
      if (model.view === 'full') lines.push("No functions were found in the current worktree's code files.");
      else if (!model.change.codeFiles && !model.focus) lines.push('This Story has not changed any code yet. Choose Full to map every function in the current worktree, or click a function under Repository to see its callers and what it calls.');
      else lines.push('Nothing to draw with the current filters.');
    }
    else if (!model.edges.length && model.intelligence.status !== 'pending') lines.push(anyCalls ? (model.view === 'full' ? 'The language service found no calls between these functions.' : 'No calls connect the changed code to the rest of the workspace at this depth.') : 'No call hierarchy is available for these languages, so the cards show what changed without call edges. Install a language extension that provides “Call Hierarchy” to see callers and callees.');
    if (model.intelligence.truncated.length) lines.push('Bounded: ' + model.intelligence.truncated.join('; ') + '.');
    note.hidden = !lines.length;
    note.textContent = lines.join(' ');
    applyTransform();
  }

  // ---- Selection and inspector -------------------------------------------------------------
  /**
   * Selection changes repaint the rows already on the canvas rather than rebuilding them: a rebuilt
   * row is a different element, so a double-click would never reach it, and hover and focus would
   * reset under the pointer.
   */
  function paintSelection() {
    const related = relatedTo(view.selected);
    const isolation = view.isolate && view.selected ? isolationSet() : null;
    nodesLayer.querySelectorAll('.cx-row').forEach(function (row) {
      const id = row.dataset.symbol;
      row.classList.toggle('selected', id === view.selected);
      row.classList.toggle('related', Boolean(related.callers[id] || related.callees[id]));
      row.classList.toggle('out', Boolean(related.callees[id]) && !related.callers[id]);
      row.classList.toggle('dim', Boolean(isolation && !isolation[id]));
      if (id === view.selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
    });
    nodesLayer.querySelectorAll('.cx-node').forEach(function (card) { card.classList.toggle('selected-module', card.dataset.module === view.selectedModule); });
    renderEdges();
  }

  function rowElement(symbolId) {
    return nodesLayer.querySelector('.cx-row[data-symbol="' + CSS.escape(symbolId) + '"]');
  }

  function select(symbolId, centre) {
    if (!model || !model.byId[symbolId]) return;
    view.selected = symbolId;
    view.selectedModule = null;
    view.selectedEdge = null;
    save();
    if (view.lens === 'code' && view.tab === 'graph') {
      const symbol = model.byId[symbolId];
      const module = model.moduleById[symbol.moduleId];
      let rebuild = Boolean(view.isolate);
      if (module && !view.filters[module.role]) { view.filters[module.role] = true; renderFilters(); rebuild = true; }
      if (!rowElement(symbolId)) { view.expanded[symbol.moduleId] = view.expanded[symbol.moduleId] || !symbol.primary; view.collapsed[symbol.moduleId] = false; rebuild = true; }
      if (rebuild) { computeLayout(); renderNodes(); renderEdges(); }
      else paintSelection();
      const element = rowElement(symbolId);
      if (element && document.activeElement !== search) element.focus({ preventScroll: true });
      if (centre) {
        const rows = moduleRows(model, module, view).rows;
        centreOn(symbol.moduleId, rows.findIndex(function (row) { return row.id === symbolId; }));
      }
    }
    renderInspector();
    renderOutline();
    const walkAt = model.walkthrough.indexOf(symbolId);
    if (walkAt >= 0) view.walk = walkAt;
    if (view.tab === 'walk') renderWalk();
    if (view.tab === 'trace') renderTrace();
  }

  function selectModule(moduleId, centre) {
    view.selectedModule = moduleId;
    view.selected = null;
    view.selectedEdge = null;
    save();
    paintSelection();
    if (centre) centreOn(moduleId);
    renderInspector();
    renderOutline();
  }

  function selectEdge(edgeId) {
    view.selectedEdge = edgeId;
    view.selected = null;
    view.selectedModule = null;
    save();
    paintSelection();
    renderInspector();
  }

  function segmentNodes(sentence) {
    const p = el('p');
    sentence.forEach(function (segment) {
      if (segment.code !== undefined) p.appendChild(el('code', '', segment.code));
      else if (segment.sym) p.appendChild(button('cx-ref', segment.t, function () { select(segment.sym, true); }, 'Show it'));
      else if (segment.mod) p.appendChild(button('cx-ref', segment.t, function () { selectModule(segment.mod, true); }, 'Show this file'));
      else {
        // Punctuation right after a link stays on the link's line.
        const last = p.lastChild;
        const mark = /^[.,;:)]/.exec(segment.t);
        if (mark && last && last.classList && last.classList.contains('cx-ref')) {
          const keep = el('span', 'cx-nowrap');
          p.replaceChild(keep, last);
          keep.appendChild(last);
          keep.appendChild(document.createTextNode(mark[0]));
          if (segment.t.length > 1) p.appendChild(document.createTextNode(segment.t.slice(1)));
        } else p.appendChild(document.createTextNode(segment.t));
      }
    });
    return p;
  }

  function box(title, note) {
    const node = el('div', 'cx-box');
    const heading = el('h3', '', title);
    if (note) heading.appendChild(el('small', '', note));
    node.appendChild(heading);
    return node;
  }

  function highlightSignature(text) {
    const pre = el('pre', 'cx-code');
    const pattern = /(\b(?:function|async|def|class|return|const|let|var|public|private|protected|static|fun|func|void|new|export|default|readonly|override|suspend|self|this)\b)|(\b[A-Z][A-Za-z0-9_]*\b)|("[^"]*"|'[^']*')/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) pre.appendChild(document.createTextNode(text.slice(last, match.index)));
      pre.appendChild(el('span', match[1] ? 'kw' : match[2] ? 'ty' : 'st', match[0]));
      last = match.index + match[0].length;
    }
    if (last < text.length) pre.appendChild(document.createTextNode(text.slice(last)));
    return pre;
  }

  function diffBlock(lines) {
    const block = el('div', 'cx-diff');
    block.setAttribute('role', 'table');
    lines.forEach(function (line) {
      const row = el('div', 'cx-diff-line ' + (line.k === '+' ? 'add' : line.k === '-' ? 'del' : line.a === null && line.b === null ? 'gap' : ''));
      row.appendChild(el('span', 'ln', line.b === null ? '' : line.b));
      row.appendChild(el('span', 'ln', line.a === null ? '' : line.a));
      row.appendChild(el('span', 'mk', line.k === ' ' ? '' : line.k));
      row.appendChild(el('span', 'tx', line.t));
      block.appendChild(row);
    });
    return block;
  }

  function metric(key, value, unit, sub, tone, meter) {
    const node = el('div', 'cx-metric');
    node.appendChild(el('div', 'k', key));
    const v = el('div', 'v', value);
    if (unit) v.appendChild(el('small', '', ' ' + unit));
    node.appendChild(v);
    if (meter !== undefined) {
      const bar = el('div', 'cx-meter');
      const fill = el('i', tone || '');
      fill.style.width = Math.max(4, Math.min(100, meter)) + '%';
      bar.appendChild(fill);
      node.appendChild(bar);
    }
    if (sub) node.appendChild(el('div', 's ' + (tone || ''), sub));
    return node;
  }

  function linkList(ids, emptyText, sitesFor) {
    if (!ids.length) return el('p', 'cx-muted', emptyText);
    const list = el('ul', 'cx-links');
    ids.forEach(function (id) {
      const symbol = model.byId[id];
      if (!symbol) return;
      const module = model.moduleById[symbol.moduleId];
      const li = el('li');
      li.appendChild(el('i', 'cx-dot ' + symbol.role));
      li.appendChild(button('go', symbol.qualifiedName, function () { select(id, true); }, 'Show it'));
      const where = el('span', 'where', (module.external ? (module.label || module.name) : module.name) + (sitesFor ? sitesFor(id) : symbol.line ? ':' + symbol.line : ''));
      li.appendChild(where);
      list.appendChild(li);
    });
    return list;
  }

  function actionsFor(symbol) {
    const actions = el('div', 'cx-ins-actions');
    if (symbol.line || symbol.kind === 'file' || symbol.kind === 'module-scope') actions.appendChild(button('cx-btn', 'Open in editor', function () { post('cx.open', { symbol: symbol.id }); }));
    const owner = model.moduleById[symbol.moduleId];
    if (symbol.status !== 'unchanged' && (symbol.units.length || (owner && owner.diffable))) actions.appendChild(button('cx-btn', 'Compare diff', function () { post('cx.diff', { symbol: symbol.id }); }, 'Before and after, exactly as captured'));
    if (model.modelEnabled) actions.appendChild(button('cx-btn', '✦ Ask Copilot', function () { post('cx.ask', { symbol: symbol.id }); }, 'Opens chat with a prompt you review before sending'));
    actions.appendChild(button('cx-btn', 'Copy', function () { post('cx.copy', { symbol: symbol.id }); }, 'Copy this explanation'));
    return actions;
  }

  function renderInspector() {
    inspector.replaceChildren();
    if (!model) return;
    if (view.lens !== 'code' && !view.selected && !view.selectedModule && !view.selectedEdge) return renderLensInspector();
    if (view.lens !== 'code' && view.lensItem) {
      inspector.appendChild(button('cx-back', '← Back to ' + LENS_NAME[view.lens], function () { view.selected = null; view.selectedModule = null; view.selectedEdge = null; save(); renderInspector(); }));
    }
    if (view.selectedEdge) return renderEdgeInspector();
    if (view.selectedModule) return renderModuleInspector();
    const symbol = model.byId[view.selected];
    if (!symbol) {
      const empty = el('div', 'cx-empty');
      empty.appendChild(el('h2', '', 'Select a function'));
      empty.appendChild(el('p', '', 'Click a row on the graph, a step in the walkthrough or an entry in the outline to see what it does, what changed, who calls it and which tests name it.'));
      inspector.appendChild(empty);
      return;
    }
    const module = model.moduleById[symbol.moduleId];
    const eyebrow = el('div', 'cx-ins-eyebrow');
    eyebrow.appendChild(el('span', 'cx-label', 'Selected ' + (symbol.kind === 'module-scope' || symbol.kind === 'file' ? 'change' : symbol.kind)));
    eyebrow.appendChild(chip(ROLE_LABEL[symbol.role], symbol.role === 'changed' ? 'ok' : symbol.role === 'caller' ? 'info' : 'dim'));
    inspector.appendChild(eyebrow);
    inspector.appendChild(el('div', 'cx-ins-title', symbol.qualifiedName));
    inspector.appendChild(el('div', 'cx-ins-path', (module.external ? (module.label || module.path) : module.path) + (symbol.start ? ' · lines ' + symbol.start + '–' + symbol.end : '')));
    const badges = el('div', 'cx-badges');
    if (symbol.status === 'modified') badges.appendChild(chip('Modified +' + symbol.added + ' −' + symbol.removed, 'warn'));
    if (symbol.status === 'added') badges.appendChild(chip('New +' + symbol.added, 'ok'));
    if (symbol.status === 'removed') badges.appendChild(chip('Removed', 'bad'));
    if (symbol.status === 'unchanged') badges.appendChild(chip('Unchanged', 'dim'));
    if (symbol.tests.length) badges.appendChild(chip(symbol.tests.length + ' test reference' + (symbol.tests.length === 1 ? '' : 's'), 'warn'));
    symbol.tags.forEach(function (tag) { badges.appendChild(chip('@clause ' + tag.clause, 'ok')); });
    symbol.clauses.forEach(function (clause) { badges.appendChild(chip(clause, 'info')); });
    inspector.appendChild(badges);
    inspector.appendChild(actionsFor(symbol));

    const explain = box('Explanation', 'from code facts · no model');
    const prose = el('div', 'cx-explain');
    symbol.explanation.forEach(function (sentence) { prose.appendChild(segmentNodes(sentence)); });
    explain.appendChild(prose);
    inspector.appendChild(explain);

    if (symbol.metrics) {
      const metrics = el('div', 'cx-metrics');
      const m = symbol.metrics;
      const tone = m.complexity <= 5 ? 'good' : m.complexity <= 10 ? 'warn' : 'bad';
      metrics.appendChild(metric('Complexity', String(m.complexity), '/ guide ≤ 10', m.band + ' · estimated', tone, m.complexity * 6.6));
      metrics.appendChild(metric('Size', String(m.lines), 'lines', m.params === null ? 'parameters unknown' : m.params + ' parameter' + (m.params === 1 ? '' : 's'), '', undefined));
      metrics.appendChild(metric('Callers', String(symbol.callers.length), symbol.callStatus === 'complete' ? 'found' : '', symbol.callStatus === 'complete' ? 'language service' : symbol.callStatus === 'unavailable' ? 'unavailable' : 'not asked', '', undefined));
      metrics.appendChild(metric('Calls', String(symbol.callees.length), '', 'nesting depth ' + m.nesting, '', undefined));
      metrics.appendChild(metric('Tests', String(symbol.tests.length), 'refs', symbol.testStatus === 'complete' ? (symbol.tests.length ? 'named in tests' : 'none name it') : symbol.testStatus === 'unavailable' ? 'unavailable' : 'not asked', symbol.tests.length ? 'good' : symbol.testStatus === 'complete' && symbol.status !== 'unchanged' ? 'warn' : '', undefined));
      metrics.appendChild(metric('Change', symbol.status === 'unchanged' ? '—' : '+' + symbol.added + ' −' + symbol.removed, '', symbol.units.length ? symbol.units.join(' ') : symbol.status, symbol.status === 'unchanged' ? '' : 'warn', undefined));
      inspector.appendChild(metrics);
    }

    if (symbol.signature) {
      const sig = box('Signature', symbol.signatureSource === 'language-service' ? 'typed · language service' : 'declaration text');
      sig.appendChild(highlightSignature(symbol.signature));
      inspector.appendChild(sig);
    }
    if (symbol.diff.length) {
      const change = box('What changed here', symbol.diffTruncated ? 'first lines only' : 'captured patch');
      change.appendChild(diffBlock(symbol.diff));
      inspector.appendChild(change);
    }
    const callers = box('Called by', symbol.callStatus === 'unavailable' ? 'call hierarchy unavailable' : '');
    callers.appendChild(linkList(symbol.callers, symbol.callStatus === 'complete' ? 'No callers in this workspace.' : 'Not known.', function (id) {
      const edge = model.edges.find(function (entry) { return entry.from === id && entry.to === symbol.id; });
      return edge && edge.sites.length ? ':' + edge.sites.join(', ') : '';
    }));
    inspector.appendChild(callers);
    const callees = box('Calls');
    callees.appendChild(linkList(symbol.callees, symbol.callStatus === 'complete' ? 'Calls nothing the language service resolved.' : 'Not known.'));
    inspector.appendChild(callees);
    const tests = box('Tests that name it', 'references, not coverage');
    if (symbol.tests.length) {
      const list = el('ul', 'cx-links');
      symbol.tests.forEach(function (reference, at) {
        const li = el('li');
        li.appendChild(el('i', 'cx-dot test'));
        li.appendChild(button('go', reference.path, function () { post('cx.openTest', { symbol: symbol.id, index: at }); }, 'Open the test at this line'));
        li.appendChild(el('span', 'where', ':' + reference.line));
        list.appendChild(li);
      });
      tests.appendChild(list);
    } else tests.appendChild(el('p', 'cx-muted', symbol.testStatus === 'complete' ? 'No test file refers to it.' : 'Not asked for this symbol.'));
    inspector.appendChild(tests);
  }

  function renderModuleInspector() {
    const module = model.moduleById[view.selectedModule];
    if (!module) return;
    const eyebrow = el('div', 'cx-ins-eyebrow');
    eyebrow.appendChild(el('span', 'cx-label', 'Selected file'));
    eyebrow.appendChild(chip(ROLE_LABEL[module.role], module.role === 'changed' ? 'ok' : 'dim'));
    inspector.appendChild(eyebrow);
    inspector.appendChild(el('div', 'cx-ins-title', module.external ? (module.label || module.name) : module.name));
    inspector.appendChild(el('div', 'cx-ins-path', module.external ? 'Outside this repository' : module.path));
    const badges = el('div', 'cx-badges');
    badges.appendChild(chip(module.language, 'dim'));
    badges.appendChild(chip(module.status, module.status === 'added' ? 'ok' : module.status === 'deleted' ? 'bad' : module.status === 'modified' ? 'warn' : 'dim'));
    if (module.added || module.removed) badges.appendChild(chip('+' + module.added + ' −' + module.removed, 'warn'));
    module.tagged.forEach(function (clause) { badges.appendChild(chip('@clause ' + clause, 'ok')); });
    module.clauses.forEach(function (clause) { badges.appendChild(chip(clause, 'info')); });
    inspector.appendChild(badges);
    const actions = el('div', 'cx-ins-actions');
    if (!module.external) actions.appendChild(button('cx-btn', 'Open in editor', function () { post('cx.openModule', { module: module.id }); }));
    if (module.units.length) actions.appendChild(button('cx-btn', 'Change Explorer', function () { post('cx.changeExplorer', { module: module.id }); }));
    inspector.appendChild(actions);
    const about = box('About this file');
    const prose = el('div', 'cx-explain');
    const changed = module.symbolIds.filter(function (id) { return model.byId[id].status !== 'unchanged'; });
    prose.appendChild(el('p', '', module.status === 'unchanged'
      ? 'This file is unchanged. It is on the graph because ' + (module.role === 'caller' || module.role === 'test' ? 'it calls changed code.' : module.role === 'callee' ? 'changed code calls it.' : 'it holds the code you asked about.')
      : 'This change ' + (module.status === 'added' ? 'adds' : module.status === 'deleted' ? 'deletes' : 'edits') + ' this file: +' + module.added + ' −' + module.removed + ' lines across ' + changed.length + ' symbol' + (changed.length === 1 ? '' : 's') + '.'));
    if (module.symbolSource === 'none') prose.appendChild(el('p', '', 'No symbol outline was available' + (module.symbolReason ? ': ' + module.symbolReason : '') + '. Its changes are shown at file level.'));
    if (module.symbolSource === 'text') prose.appendChild(el('p', '', 'No language service answered for this file, so its outline was read from its own text. It shows which function a changed line is in; callers, callees and test references need a language service.'));
    if (module.opaque) prose.appendChild(el('p', '', 'Its content is not represented as text (' + module.opaque.replace(/-/g, ' ') + ').'));
    about.appendChild(prose);
    inspector.appendChild(about);
    const members = box('Symbols', module.symbolIds.length + ' in this view');
    members.appendChild(linkList(module.symbolIds, 'No symbols.'));
    inspector.appendChild(members);
  }

  function renderEdgeInspector() {
    const edge = model.edges.find(function (entry) { return entry.id === view.selectedEdge; });
    if (!edge) return;
    const from = model.byId[edge.from], to = model.byId[edge.to];
    const eyebrow = el('div', 'cx-ins-eyebrow');
    eyebrow.appendChild(el('span', 'cx-label', 'Selected call'));
    eyebrow.appendChild(chip(edge.sites.length + ' site' + (edge.sites.length === 1 ? '' : 's'), 'dim'));
    inspector.appendChild(eyebrow);
    const title = el('div', 'cx-ins-title');
    title.appendChild(button('cx-ref', from.qualifiedName, function () { select(from.id, true); }));
    title.appendChild(document.createTextNode(' → '));
    title.appendChild(button('cx-ref', to.qualifiedName, function () { select(to.id, true); }));
    inspector.appendChild(title);
    const sites = box('Call sites', 'in ' + model.moduleById[from.moduleId].path);
    const list = el('ul', 'cx-links');
    edge.sites.forEach(function (line) {
      const li = el('li');
      li.appendChild(button('go', 'line ' + line, function () { post('cx.openSite', { edge: edge.id, line: line }); }, 'Open the call'));
      list.appendChild(li);
    });
    sites.appendChild(edge.sites.length ? list : el('p', 'cx-muted', 'The language service did not report positions.'));
    inspector.appendChild(sites);
    inspector.appendChild(el('p', 'cx-muted', 'A call edge is what the language service resolved statically. Dynamic dispatch, callbacks and reflection can add calls it cannot see.'));
  }

  // ---- Trace -------------------------------------------------------------------------------
  let traceLit = null;
  function renderTrace() {
    const holder = $('cx-trace');
    holder.replaceChildren();
    if (!model) return;
    const trace = model.trace;
    const summary = el('div', 'cx-trace-summary');
    const add = function (value, label) { const span = el('span'); span.appendChild(el('strong', '', value)); span.appendChild(document.createTextNode(' ' + label)); summary.appendChild(span); };
    add(trace.counts.requirements, 'requirements');
    add(trace.counts.declared, 'named by @clause tags');
    add(trace.counts.tagged, 'tagged by tests');
    add(trace.counts.gaps, 'without a test tag');
    add(trace.code.length, 'changed files');
    add(trace.counts.tests, 'test files');
    add(trace.counts.passed + '/' + trace.counts.runs, 'recorded runs passed');
    holder.appendChild(summary);
    if (!trace.available && !trace.code.length) {
      const empty = el('div', 'cx-empty');
      empty.appendChild(el('h2', '', 'No trace for this view'));
      empty.appendChild(el('p', '', trace.reason || 'There is no captured change to trace.'));
      holder.appendChild(empty);
      return;
    }
    const grid = el('div', 'cx-trace-grid');
    const linksSvg = svg('svg', { class: 'cx-trace-links' });
    grid.appendChild(linksSvg);
    const cards = {};
    const links = [];
    const lit = traceLit;
    const chain = {};
    if (lit) {
      chain[lit] = true;
      trace.requirements.forEach(function (requirement) {
        const key = 'r:' + requirement.id;
        const touches = key === lit || requirement.modules.some(function (m) { return 'c:' + m === lit; }) || requirement.tests.some(function (t) { return 't:' + t === lit; });
        if (touches) { chain[key] = true; requirement.modules.forEach(function (m) { chain['c:' + m] = true; }); requirement.tests.forEach(function (t) { chain['t:' + t] = true; }); }
      });
      trace.tests.forEach(function (test) {
        const key = 't:' + test.id;
        const viaSymbols = test.symbols.map(function (id) { return model.byId[id] && model.byId[id].moduleId; });
        if (key === lit || viaSymbols.some(function (m) { return 'c:' + m === lit; })) {
          chain[key] = true;
          viaSymbols.forEach(function (m) { if (m) chain['c:' + m] = true; });
          test.requirements.forEach(function (r) { chain['r:' + r] = true; });
        }
      });
    }
    function column(title, count) {
      const col = el('div', 'cx-trace-col');
      const heading = el('h3');
      heading.appendChild(el('span', 'n', String(count)));
      heading.appendChild(document.createTextNode(title));
      col.appendChild(heading);
      grid.appendChild(col);
      return col;
    }
    function card(col, key, build) {
      const node = button('cx-tcard' + (lit ? (chain[key] ? ' lit' : ' dim') : ''), '', function () { traceLit = traceLit === key ? null : key; renderTrace(); });
      build(node);
      col.appendChild(node);
      cards[key] = node;
      return node;
    }
    const gapsOnly = view.gapsOnly;
    const requirements = trace.requirements.filter(function (r) { return !gapsOnly || r.status !== 'tagged' || r.gap; });
    const reqCol = column('Requirements', requirements.length);
    requirements.forEach(function (requirement) {
      card(reqCol, 'r:' + requirement.id, function (node) {
        const id = el('span', 'id', requirement.id);
        id.appendChild(chip(requirement.status === 'tagged' ? 'tagged' : requirement.gap ? 'gap' : 'declared', requirement.status === 'tagged' ? 'ok' : requirement.gap ? 'warn' : 'dim'));
        node.appendChild(id);
        if (requirement.text) node.appendChild(el('span', 'tx', requirement.text));
        requirement.notes.forEach(function (entry) { node.appendChild(el('span', 'sym', '✎ ' + entry.path + ':' + entry.line + ' — ' + entry.note)); });
        requirement.cites.forEach(function (id) { node.appendChild(el('span', 'sym', 'cites ' + id)); });
        requirement.citedBy.forEach(function (id) { node.appendChild(el('span', 'sym', 'cited by ' + id)); });
        if (requirement.gap) node.appendChild(el('span', 'tx', '⚠ ' + requirement.gap));
      });
      requirement.modules.forEach(function (m) { links.push({ from: 'r:' + requirement.id, to: 'c:' + m, kind: requirement.declaredIn.indexOf(m) >= 0 ? 'declared' : 'region' }); });
    });
    if (!requirements.length) reqCol.appendChild(el('p', 'cx-muted', trace.available ? (gapsOnly ? 'No requirement gaps.' : 'No requirement clauses were read for this change.') : (trace.reason || 'Unavailable.')));
    const codeCol = column('Changed code', trace.code.length);
    trace.code.forEach(function (entry) {
      const module = model.moduleById[entry.moduleId];
      if (!module) return;
      card(codeCol, 'c:' + entry.moduleId, function (node) {
        const id = el('span', 'id', module.path);
        node.appendChild(id);
        node.appendChild(delta(module.added, module.removed));
        entry.symbols.slice(0, 6).forEach(function (symbolId) {
          const symbol = model.byId[symbolId];
          if (symbol) node.appendChild(el('span', 'sym', '· ' + symbol.qualifiedName + (symbol.added || symbol.removed ? '  +' + symbol.added + ' −' + symbol.removed : '')));
        });
        if (entry.symbols.length > 6) node.appendChild(el('span', 'tx', '… ' + (entry.symbols.length - 6) + ' more'));
      });
    });
    const tests = trace.tests.filter(function (t) { return !gapsOnly || !t.requirements.length; });
    const testCol = column('Tests', tests.length);
    tests.forEach(function (test) {
      card(testCol, 't:' + test.id, function (node) {
        node.appendChild(el('span', 'id', test.path));
        node.appendChild(el('span', 'tx', test.source === 'reference' ? 'refers to changed code' : test.source === 'both' ? 'declared tag + refers to changed code' : 'declared requirement tag'));
        test.requirements.forEach(function (r) { node.appendChild(el('span', 'sym', '⟵ ' + r)); });
        test.symbols.slice(0, 4).forEach(function (id) { if (model.byId[id]) node.appendChild(el('span', 'sym', '→ ' + model.byId[id].qualifiedName)); });
      });
      test.requirements.forEach(function (r) { links.push({ from: 'r:' + r, to: 't:' + test.id, kind: 'tag' }); });
      test.symbols.forEach(function (id) { const symbol = model.byId[id]; if (symbol) links.push({ from: 'c:' + symbol.moduleId, to: 't:' + test.id, kind: 'reference' }); });
    });
    if (!tests.length) testCol.appendChild(el('p', 'cx-muted', 'No test declares a tag for these requirements, and no test file refers to the changed functions.'));
    const runCol = column('Recorded results', trace.runs.length);
    trace.runs.forEach(function (run) {
      card(runCol, 'x:' + run.id, function (node) {
        const id = el('span', 'id', run.label);
        id.appendChild(chip(run.status, run.status === 'passed' ? 'ok' : run.status === 'failed' ? 'bad' : 'dim'));
        node.appendChild(id);
        node.appendChild(el('span', 'tx', 'Recorded for the phase; not linked to one test.'));
      });
    });
    if (!trace.runs.length) runCol.appendChild(el('p', 'cx-muted', 'No test run is recorded for this phase generation.'));
    holder.appendChild(grid);
    holder.appendChild(el('p', 'cx-trace-note', 'Requirement → file is a @clause comment in the file (dotted) or the change region\'s recorded association (dashed), both at file level. Requirement → test is a declared @ac tag. File → test means a test file refers to a changed function. "cites" is the specification text of one requirement naming another. None of these is proof of coverage.'));
    requestAnimationFrame(function () {
      const origin = grid.getBoundingClientRect();
      linksSvg.setAttribute('width', String(grid.scrollWidth));
      linksSvg.setAttribute('height', String(grid.scrollHeight));
      links.forEach(function (link) {
        const a = cards[link.from], b = cards[link.to];
        if (!a || !b) return;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const left = ra.left < rb.left ? ra : rb, right = ra.left < rb.left ? rb : ra;
        const x1 = left.right - origin.left, y1 = left.top + left.height / 2 - origin.top;
        const x2 = right.left - origin.left, y2 = right.top + right.height / 2 - origin.top;
        const on = lit && chain[link.from] && chain[link.to];
        linksSvg.appendChild(svg('path', { d: edgePath(x1, y1, x2, y2), class: link.kind + (lit ? (on ? ' lit' : ' dim') : '') }));
      });
    });
  }

  // ---- Repository --------------------------------------------------------------------------
  // What the repository holds (explain code --repository): one scope at a time, the whole
  // repository when it fits the AST budget, otherwise a folder or file the reader picks.
  const repo = { path: null, explanation: null, loading: false, error: null };
  // The host resolves every request against the explanation it read: an entry by its index, never
  // a path named here.
  function askRepository(to, index) {
    repo.error = null;
    // Requests carry the model they were made from; until the first view arrives, wait for it.
    repo.loading = Boolean(model);
    if (model) post('cx.repository', index === undefined ? { to: to } : { to: to, index: index });
    renderRepo();
  }
  function sizeLabel(bytes) {
    if (typeof bytes !== 'number') return '';
    return bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / 1048576).toFixed(1) + ' MiB';
  }
  function renderRepo() {
    const holder = $('cx-repo');
    holder.replaceChildren();
    $('cx-repo-scope').textContent = repo.path ? 'Scope: ' + repo.path : 'What the repository holds';
    const up = root.querySelector('[data-action="repo-up"]');
    if (up) up.disabled = !repo.path;
    if (repo.loading) { holder.appendChild(el('p', 'cx-muted', 'Reading the repository…')); return; }
    if (repo.error) {
      const empty = el('div', 'cx-empty');
      empty.appendChild(el('h2', '', 'The repository could not be explained'));
      empty.appendChild(el('p', '', repo.error));
      holder.appendChild(empty);
      return;
    }
    const data = repo.explanation;
    if (!data) { holder.appendChild(el('p', 'cx-muted', 'Nothing has been read yet.')); return; }
    $('cx-count-repo').textContent = data.counts && data.counts.files != null ? String(data.counts.files) : '';
    const summary = el('div', 'cx-repo-summary');
    const budget = data.budget;
    const line = function (strong, rest) { const p = el('div'); p.appendChild(el('strong', '', strong)); p.appendChild(document.createTextNode(' ' + rest)); summary.appendChild(p); };
    if (budget.status === 'over-budget') {
      line((budget.files == null ? 'More' : budget.files) + ' application files', 'exceed the AST budget of ' + budget.maxFiles + ' files and ' + sizeLabel(budget.maxBytes) + ', so this scope is explained a folder or file at a time. Pick one below; nothing is indexed until you do.');
    } else {
      line(budget.files + ' application file' + (budget.files === 1 ? '' : 's'), sizeLabel(budget.bytes) + ', within the AST budget of ' + budget.maxFiles + ' files and ' + sizeLabel(budget.maxBytes) + '.');
      const index = data.index || {};
      if (index.status === 'disabled') line('Declarations', 'are not listed: structural intelligence (AST) is off.');
      else if (index.counts) line(index.counts.symbols + ' declaration' + (index.counts.symbols === 1 ? '' : 's'),
        'from ' + index.counts.indexedFiles + ' indexed file(s)' + (index.counts.workingTreeFiles ? ' and ' + index.counts.workingTreeFiles + ' read from the working tree' : '')
        + (index.counts.notIndexedFiles ? '; ' + index.counts.notIndexedFiles + ' not indexed' : '')
        + (index.warm && index.warm.mode === 'background' && index.warm.status === 'complete' ? '; indexed in the background when the workspace was set up' : '') + '.');
    }
    if (data.hiddenSingularityFiles) line(String(data.hiddenSingularityFiles), 'Singularity Flow files are not code and are not shown.');
    holder.appendChild(summary);
    if (data.entries.length) {
      const section = el('section');
      section.appendChild(el('h3', '', data.scope.kind === 'repository' ? 'Folders and files' : 'Inside ' + data.scope.path));
      const grid = el('div', 'cx-repo-entries');
      data.entries.forEach(function (entry, entryIndex) {
        const button = el('button', 'cx-repo-entry');
        button.type = 'button';
        button.dataset.action = 'repo-scope';
        button.dataset.index = String(entryIndex);
        button.appendChild(el('strong', '', entry.path + (entry.kind === 'folder' ? '/' : '')));
        button.appendChild(el('small', '', (entry.kind === 'folder' ? entry.files + ' file' + (entry.files === 1 ? '' : 's') + ' · ' : '')
          + entry.languages.map(function (item) { return item.language + ' ' + item.files; }).join(' · ') + (entry.tests ? ' · ' + entry.tests + ' test' : '')));
        button.title = 'Explain ' + entry.path;
        grid.appendChild(button);
      });
      section.appendChild(grid);
      if (data.entriesTotal > data.entries.length) section.appendChild(el('p', 'cx-muted', (data.entriesTotal - data.entries.length) + ' more entries are counted, not shown.'));
      holder.appendChild(section);
    }
    const described = (data.files || []).map(function (file, fileIndex) { return { file: file, index: fileIndex }; })
      .filter(function (item) { return item.file.symbols.length || item.file.tags.length; });
    if (described.length) {
      const section = el('section');
      section.appendChild(el('h3', '', 'Code'));
      described.slice(0, 200).forEach(function (item) {
        const file = item.file;
        const row = el('div', 'cx-repo-file');
        const head = el('div', 'head');
        head.appendChild(el('span', '', file.path));
        head.appendChild(el('small', '', file.language + ' · ' + sizeLabel(file.bytes) + (file.test ? ' · test' : '')));
        row.appendChild(head);
        if (file.symbols.length) {
          const syms = el('div', 'cx-repo-syms');
          file.symbols.forEach(function (symbol) {
            const chipButton = el('button', 'cx-repo-sym', symbol.kind + ' ' + symbol.name);
            chipButton.type = 'button';
            chipButton.dataset.action = 'repo-open';
            chipButton.dataset.index = String(item.index);
            chipButton.dataset.line = String(symbol.line);
            chipButton.title = 'Explain ' + symbol.name + ' (line ' + symbol.line + '): its callers, what it calls and its tests';
            syms.appendChild(chipButton);
          });
          if (file.symbolCount > file.symbols.length) syms.appendChild(el('span', 'cx-repo-tag', (file.symbolCount - file.symbols.length) + ' more'));
          row.appendChild(syms);
        }
        file.tags.forEach(function (tag) {
          row.appendChild(el('span', 'cx-repo-tag', '@' + tag.tag + ' ' + tag.clauseId + ' at line ' + tag.line + (tag.note ? ': “' + tag.note + '”' : '')));
        });
        section.appendChild(row);
      });
      holder.appendChild(section);
    }
    if ((data.clauses || []).length) {
      const section = el('section');
      section.appendChild(el('h3', '', 'Clauses tagged in code and tests'));
      data.clauses.forEach(function (clause) {
        const code = clause.code.map(function (entry) { return entry.path + ':' + entry.line; }).join(', ') || 'no code';
        const tests = clause.tests.map(function (entry) { return entry.path + ':' + entry.line; }).join(', ') || 'no test';
        section.appendChild(el('p', 'cx-repo-tag', clause.clauseId + ' — code: ' + code + ' · tests: ' + tests));
      });
      holder.appendChild(section);
    }
    holder.appendChild(el('p', 'cx-muted', 'A declaration is what the AST index records; a tag is the author\'s declaration. Neither shows behavior or coverage.'));
  }

  // ---- Walkthrough -------------------------------------------------------------------------
  function renderWalk() {
    const holder = $('cx-walk');
    holder.replaceChildren();
    if (!model) return;
    const steps = model.walkthrough;
    if (!steps.length) {
      const empty = el('div', 'cx-empty');
      empty.appendChild(el('h2', '', 'Nothing to walk through'));
      empty.appendChild(el('p', '', model.change.status === 'unavailable' ? (model.change.reason || 'No change is captured.') : 'This change has no code symbols to read in order.'));
      holder.appendChild(empty);
      return;
    }
    view.walk = Math.max(0, Math.min(view.walk, steps.length - 1));
    const list = el('div', 'cx-steps');
    list.setAttribute('role', 'listbox');
    steps.forEach(function (id, at) {
      const symbol = model.byId[id];
      if (!symbol) return;
      const module = model.moduleById[symbol.moduleId];
      const step = button('cx-step' + (at === view.walk ? ' current' : ''), '', function () { view.walk = at; save(); renderWalk(); });
      step.setAttribute('role', 'option');
      step.setAttribute('aria-selected', String(at === view.walk));
      step.appendChild(el('span', 'no', at + 1));
      const text = el('span');
      text.appendChild(el('span', 'nm', symbol.qualifiedName));
      text.appendChild(el('small', '', module.name + ' · ' + (symbol.status === 'unchanged' ? symbol.role : symbol.status + ' +' + symbol.added + ' −' + symbol.removed)));
      step.appendChild(text);
      list.appendChild(step);
    });
    holder.appendChild(list);
    const symbol = model.byId[steps[view.walk]];
    const module = model.moduleById[symbol.moduleId];
    const body = el('div', 'cx-walk-body');
    const head = el('div', 'cx-walk-head');
    head.appendChild(el('span', 'cx-label', 'Step ' + (view.walk + 1) + ' of ' + steps.length));
    head.appendChild(el('h2', '', symbol.qualifiedName));
    const nav = el('div', 'cx-walk-nav');
    const prev = button('cx-btn', '← Previous', function () { stepWalk(-1); });
    prev.disabled = view.walk === 0;
    const next = button('cx-btn cx-primary', 'Next →', function () { stepWalk(1); });
    next.disabled = view.walk === steps.length - 1;
    nav.appendChild(prev); nav.appendChild(next);
    head.appendChild(nav);
    body.appendChild(head);
    body.appendChild(el('div', 'cx-ins-path', module.path + (symbol.start ? ' · lines ' + symbol.start + '–' + symbol.end : '')));
    const actions = actionsFor(symbol);
    actions.insertBefore(button('cx-btn', 'Show on graph', function () { setTab('graph'); select(symbol.id, true); }), actions.firstChild);
    body.appendChild(actions);
    const grid = el('div', 'cx-walk-grid');
    const left = el('div');
    const explain = box('What this step does', 'from code facts · no model');
    const prose = el('div', 'cx-explain');
    symbol.explanation.forEach(function (sentence) { prose.appendChild(segmentNodes(sentence)); });
    explain.appendChild(prose);
    left.appendChild(explain);
    if (symbol.signature) { const sig = box('Signature'); sig.appendChild(highlightSignature(symbol.signature)); left.appendChild(sig); }
    const right = el('div');
    const change = box('The change', symbol.diffTruncated ? 'first lines only' : 'captured patch');
    change.appendChild(symbol.diff.length ? diffBlock(symbol.diff) : el('p', 'cx-muted', symbol.status === 'added' ? 'New in this change; open it to read the whole body.' : 'No text change inside this symbol.'));
    right.appendChild(change);
    const flow = box('Where it sits');
    flow.appendChild(el('p', 'cx-muted', 'Called by'));
    flow.appendChild(linkList(symbol.callers, 'No callers found.'));
    flow.appendChild(el('p', 'cx-muted', 'Calls'));
    flow.appendChild(linkList(symbol.callees, 'Nothing resolved.'));
    right.appendChild(flow);
    grid.appendChild(left); grid.appendChild(right);
    body.appendChild(grid);
    holder.appendChild(body);
  }

  function stepWalk(delta) {
    const steps = model ? model.walkthrough : [];
    if (!steps.length) return;
    view.walk = Math.max(0, Math.min(steps.length - 1, view.walk + delta));
    view.selected = steps[view.walk];
    save();
    renderWalk();
    renderInspector();
    renderOutline();
  }


  // ---- Lenses ------------------------------------------------------------------------------
  // The Code lens is the graph, trace, walkthrough and repository; the others draw the same
  // harvest as concepts, entities, data flow and logic. All of them are built by the host.
  const LENSES = ['code', 'concepts', 'entities', 'flow', 'logic'];
  const LENS_NAME = { code: 'Code', concepts: 'Concepts', entities: 'Entities', flow: 'Data flow', logic: 'Logic' };
  const FLOW_KIND = { entry: 'enters', step: 'step', state: 'state', sink: 'leaves', source: 'read from' };
  function lenses() { return model && model.lenses ? model.lenses : null; }
  function paintLensBar() {
    LENSES.forEach(function (name) {
      const tab = $('cx-lens-' + name);
      tab.setAttribute('aria-selected', String(name === view.lens));
      tab.tabIndex = name === view.lens ? 0 : -1;
    });
    const code = view.lens === 'code';
    $('cx-tabs-row').hidden = !code;
    $('cx-main').classList.toggle('lens-mode', !code);
    ['concepts', 'entities', 'flow', 'logic'].forEach(function (name) { $('cx-view-' + name).hidden = name !== view.lens; });
    if (!code) {
      ['graph', 'trace', 'walk', 'repo'].forEach(function (name) { $('cx-view-' + name).hidden = true; });
      $('cx-main').classList.remove('walk-mode');
    }
  }
  function lensWidth(id) {
    const holder = $(id);
    return Math.max(260, (holder && holder.clientWidth ? holder.clientWidth : 640) - 36);
  }
  function setLens(lens) {
    const next = LENSES.indexOf(lens) >= 0 ? lens : 'code';
    if (next !== view.lens) view.lensItem = null;
    view.lens = next;
    save();
    paintLensBar();
    if (view.lens === 'code') { setTab(view.tab); if (model) renderInspector(); return; }
    if (!model) return;
    renderLens();
    renderInspector();
  }
  function renderLens() {
    if (view.lens === 'concepts') renderConcepts();
    else if (view.lens === 'entities') renderEntities();
    else if (view.lens === 'flow') renderFlow();
    else if (view.lens === 'logic') renderLogic();
  }
  function lensUnavailable(holder) {
    const empty = el('div', 'cx-empty');
    empty.appendChild(el('h2', '', model && model.intelligence.status === 'pending' ? 'Still reading the code' : 'Nothing to draw yet'));
    empty.appendChild(el('p', '', model && model.intelligence.status === 'pending'
      ? 'This lens is drawn from what the language services answer; it fills in as they do.'
      : 'This lens could not be built for this view. How this view was built (the engine item below) says why.'));
    holder.appendChild(empty);
  }
  function pickLens(kind, id) {
    view.lensItem = { kind: kind, id: id };
    view.selected = null; view.selectedModule = null; view.selectedEdge = null;
    save();
    paintLensSelection();
    renderInspector();
  }
  function paintLensSelection() {
    const chosen = view.lensItem ? view.lensItem.id : null;
    root.querySelectorAll('[data-lens-item]').forEach(function (node) { node.classList.toggle('selected', node.dataset.lensItem === chosen); });
  }
  function lensSection(holder, title, note) {
    const section = el('section', 'cx-lens-section');
    const heading = el('h3', '', title);
    if (note) heading.appendChild(el('small', '', note));
    section.appendChild(heading);
    holder.appendChild(section);
    return section;
  }
  function moduleName(moduleId) {
    const module = model.moduleById[moduleId];
    return module ? module.name : moduleId.replace(/^m:/, '');
  }
  /** Arrow paths between absolutely placed boxes, with an optional label at the middle. */
  function drawLinks(layer, links, boxes, options) {
    links.forEach(function (link) {
      const a = boxes[link.from], b = boxes[link.to];
      if (!a || !b) return;
      const forward = b.x > a.x + a.w / 2 || (options && options.down && b.y > a.y + a.h / 2);
      let d, mx, my;
      if (options && options.down && b.y >= a.y + a.h) {
        const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
        d = 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + (y1 + 30) + ' ' + x2 + ' ' + (y2 - 30) + ' ' + x2 + ' ' + y2;
        // The point 70% along the curve, nearer the target than the shared source.
        const t = 0.7, u = 1 - t;
        mx = u * u * u * x1 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x2;
        my = u * u * u * y1 + 3 * u * u * t * (y1 + 30) + 3 * u * t * t * (y2 - 30) + t * t * t * y2;
      } else {
        const x1 = forward ? a.x + a.w : a.x, y1 = a.y + Math.min(a.h / 2, 26), x2 = forward ? b.x : b.x + b.w, y2 = b.y + Math.min(b.h / 2, 26);
        d = edgePath(x1, y1, x2, y2);
        mx = (x1 + x2) / 2; my = (y1 + y2) / 2;
      }
      const group = svg('g', { class: 'lens-link ' + (link.kind || ''), 'data-lens-item': link.id || '' });
      group.appendChild(svg('path', { d: d, class: 'line' + (link.dashed ? ' dashed' : ''), 'marker-end': 'url(#cx-lens-arrow)' }));
      if (link.id) group.appendChild(svg('path', { d: d, class: 'hit' }));
      if (link.label) {
        const text = String(link.label);
        const shown = text.length > 44 ? text.slice(0, 43) + '…' : text;
        const width = Math.min(300, shown.length * 6.4 + 12);
        group.appendChild(svg('rect', { x: mx - width / 2, y: my - 9, width: width, height: 18, rx: 4, class: 'label-bg' }));
        const label = svg('text', { x: mx, y: my + 4, 'text-anchor': 'middle', class: 'label' });
        label.textContent = shown;
        group.appendChild(label);
        const title = svg('title', {});
        title.textContent = text;
        group.appendChild(title);
      }
      layer.appendChild(group);
    });
  }
  /** A horizontal scroller as tall as its drawing: the lens body scrolls down, this scrolls across. */
  function lensScroller(world) {
    const scroller = el('div', 'cx-lens-scroll');
    scroller.appendChild(world);
    scroller.style.minHeight = (parseFloat(world.style.height) || 0) + 18 + 'px';
    return scroller;
  }
  function lensWorld(width, height) {
    const world = el('div', 'cx-lens-world');
    world.style.width = Math.ceil(width) + 'px';
    world.style.height = Math.ceil(height) + 'px';
    const layer = svg('svg', { class: 'cx-lens-links', width: Math.ceil(width), height: Math.ceil(height) });
    const defs = svg('defs', {});
    const marker = svg('marker', { id: 'cx-lens-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.appendChild(svg('path', { d: 'M1 1L9 5L1 9', class: 'arrow' }));
    defs.appendChild(marker);
    layer.appendChild(defs);
    world.appendChild(layer);
    return { world: world, layer: layer };
  }

  // Concepts: how the code is organised, and the words it is about.
  const TIERS = [['entry', 'ui'], ['cross-cutting', 'logic'], ['data', 'storage'], ['config', 'utility', 'other']];
  function renderConcepts() {
    const holder = $('cx-concepts');
    holder.replaceChildren();
    const data = lenses();
    if (!data) { lensUnavailable(holder); return; }
    const lens = data.concepts;
    holder.appendChild(el('p', 'cx-lens-summary', lens.summary));
    const arch = lensSection(holder, 'How it is organised', 'each file placed by the evidence it names');
    const byId = {};
    lens.layers.forEach(function (layer) { byId[layer.id] = layer; });
    const W = 230, GAP_X = 40, GAP_Y = 54, HEAD = 40, LINE = 18;
    const boxes = {};
    let y = 0, width = 0;
    const rows = [];
    TIERS.forEach(function (tier) {
      const present = tier.filter(function (id) { return byId[id]; });
      if (!present.length) return;
      const height = Math.max.apply(null, present.map(function (id) { const n = byId[id].modules.length; return HEAD + LINE * Math.min(5, n) + (n > 5 ? LINE : 0) + 10; }));
      rows.push({ ids: present, y: y, h: height });
      width = Math.max(width, present.length * (W + GAP_X) - GAP_X);
      y += height + GAP_Y;
    });
    rows.forEach(function (row) {
      const offset = (width - (row.ids.length * (W + GAP_X) - GAP_X)) / 2;
      row.ids.forEach(function (id, index) { boxes[id] = { x: offset + index * (W + GAP_X), y: row.y, w: W, h: row.h }; });
    });
    if (rows.length) {
      const canvasParts = lensWorld(width + 4, y - GAP_Y + 4);
      drawLinks(canvasParts.layer, lens.layerLinks.filter(function (link) { return link.from !== 'test' && link.to !== 'test'; }).map(function (link) {
        return { from: link.from, to: link.to, label: link.calls + ' call' + (link.calls === 1 ? '' : 's'), kind: 'layer' };
      }), boxes, { down: true });
      Object.keys(boxes).forEach(function (id) {
        const layer = byId[id], spot = boxes[id];
        const card = button('cx-layer ' + id, '', function () { pickLens('layer', id); }, layer.label + ': ' + layer.modules.length + ' files');
        card.dataset.lensItem = 'layer:' + id;
        card.style.transform = 'translate(' + spot.x + 'px, ' + spot.y + 'px)';
        card.style.width = spot.w + 'px';
        card.style.height = spot.h + 'px';
        const head = el('span', 'head');
        head.appendChild(el('b', '', layer.label));
        head.appendChild(el('small', '', layer.modules.length + ' file' + (layer.modules.length === 1 ? '' : 's')));
        card.appendChild(head);
        layer.modules.slice(0, 5).forEach(function (entry) { card.appendChild(el('span', 'file', moduleName(entry.id))); });
        if (layer.modules.length > 5) card.appendChild(el('span', 'more', '+ ' + (layer.modules.length - 5) + ' more'));
        canvasParts.world.appendChild(card);
      });
      const scroller = lensScroller(canvasParts.world);
      arch.appendChild(scroller);
    } else arch.appendChild(el('p', 'cx-muted', 'No code files were read.'));
    if (byId.test) {
      const tests = button('cx-filter', 'Tests · ' + byId.test.modules.length + ' file' + (byId.test.modules.length === 1 ? '' : 's'), function () { pickLens('layer', 'test'); });
      tests.dataset.lensItem = 'layer:test';
      arch.appendChild(tests);
    }
    const about = lensSection(holder, 'What it is about', 'the words its declarations use most');
    const grid = el('div', 'cx-concepts');
    const top = lens.concepts.length ? lens.concepts[0].score : 1;
    lens.concepts.forEach(function (concept) {
      const card = button('cx-concept', '', function () { pickLens('concept', concept.id); });
      card.dataset.lensItem = concept.id;
      card.appendChild(el('b', '', concept.label));
      const bar = el('span', 'bar');
      const fill = el('i');
      fill.style.width = Math.max(6, Math.round(concept.score / top * 100)) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
      card.appendChild(el('small', '', concept.symbols.length + ' declaration' + (concept.symbols.length === 1 ? '' : 's') + ' · ' + concept.modules.length + ' file' + (concept.modules.length === 1 ? '' : 's') + (concept.entities.length ? ' · ' + concept.entities.length + ' entit' + (concept.entities.length === 1 ? 'y' : 'ies') : '')));
      if (concept.related.length) {
        const related = el('span', 'related');
        concept.related.slice(0, 4).forEach(function (entry) { related.appendChild(el('span', 'cx-tag', entry.id.slice(2))); });
        card.appendChild(related);
      }
      grid.appendChild(card);
    });
    if (!lens.concepts.length) grid.appendChild(el('p', 'cx-muted', 'No domain words stood out in the declarations read.'));
    about.appendChild(grid);
    paintLensSelection();
  }

  // Entities: declared data, objects built in code and component inputs.
  const ENTITY_ROW = 19, ENTITY_HEAD = 46;
  function entityHeight(entity) {
    const rows = Math.min(12, entity.fields.length) + (entity.fields.length > 12 ? 1 : 0);
    return ENTITY_HEAD + rows * ENTITY_ROW + (entity.values.length ? 30 : 0) + 26;
  }
  function entityCard(entity) {
    const card = el('div', 'cx-entity ' + entity.kind);
    card.dataset.lensItem = entity.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const head = el('div', 'head');
    head.appendChild(el('b', '', entity.name));
    head.appendChild(chip(entity.kind, entity.kind === 'enum' ? 'warn' : entity.kind === 'props' ? 'info' : 'dim'));
    card.appendChild(head);
    card.appendChild(el('div', 'where', moduleName(entity.moduleId) + (entity.line ? ':' + entity.line : '')));
    const fields = el('div', 'fields');
    entity.fields.slice(0, 12).forEach(function (field) {
      const row = el('div', 'field');
      row.appendChild(el('span', 'cx-fname', field.name));
      row.appendChild(el('span', 'cx-ftype', field.type || ''));
      if (field.accessors.length) row.appendChild(el('span', 'acc', field.accessors.join('/')));
      fields.appendChild(row);
    });
    if (entity.fields.length > 12) fields.appendChild(el('div', 'field more', '+ ' + (entity.fields.length - 12) + ' more'));
    card.appendChild(fields);
    if (entity.values.length) {
      const values = el('div', 'values');
      entity.values.slice(0, 10).forEach(function (value) { values.appendChild(el('span', 'cx-tag', value)); });
      if (entity.values.length > 10) values.appendChild(el('span', 'cx-tag', '+' + (entity.values.length - 10)));
      card.appendChild(values);
    }
    const foot = el('div', 'foot');
    foot.appendChild(el('span', '', entity.usedBy.length ? 'used by ' + entity.usedBy.length : 'no users found'));
    if (entity.methods.length) foot.appendChild(el('span', '', entity.methods.length + ' method' + (entity.methods.length === 1 ? '' : 's')));
    card.appendChild(foot);
    const pick = function () { pickLens('entity', entity.id); };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { pick(); event.preventDefault(); } });
    return card;
  }
  function renderEntities() {
    const holder = $('cx-entities');
    holder.replaceChildren();
    const data = lenses();
    if (!data) { lensUnavailable(holder); return; }
    const lens = data.entities;
    const declared = lens.entities.filter(function (entity) { return entity.kind !== 'shape' && entity.kind !== 'props'; });
    const built = lens.entities.filter(function (entity) { return entity.kind === 'shape'; });
    const inputs = lens.entities.filter(function (entity) { return entity.kind === 'props'; });
    holder.appendChild(el('p', 'cx-lens-summary', declared.length + ' declared data type' + (declared.length === 1 ? '' : 's') + ', ' + built.length + ' object' + (built.length === 1 ? '' : 's') + ' built in code and ' + inputs.length + ' component input' + (inputs.length === 1 ? '' : 's') + '. ' + (lens.links.length ? lens.links.length + ' link' + (lens.links.length === 1 ? '' : 's') + ' between them.' : 'No field of one names another.')));
    if (declared.length) {
      const section = lensSection(holder, 'Declared data', 'fields, how types refer to each other, who uses them');
      const nodes = declared.map(function (entity) { return { id: entity.id, w: CARD_W, h: entityHeight(entity) }; });
      const stacked = stackLayout(nodes, lens.links.map(function (link) { return { from: link.from, to: link.to }; }), lensWidth('cx-entities'), { gapY: 56 });
      const boxes = stacked.positions;
      const parts = lensWorld(stacked.width + 4, stacked.height + 4);
      drawLinks(parts.layer, lens.links.map(function (link) {
        return { from: link.from, to: link.to, label: link.kind === 'is' ? 'is a' : link.label + (link.many ? ' (many)' : ''), dashed: link.kind === 'is', kind: link.kind };
      }), boxes, { down: true });
      declared.forEach(function (entity) {
        const card = entityCard(entity);
        const spot = boxes[entity.id];
        card.style.transform = 'translate(' + spot.x + 'px, ' + spot.y + 'px)';
        parts.world.appendChild(card);
      });
      const scroller = lensScroller(parts.world);
      section.appendChild(scroller);
    }
    if (built.length) {
      const section = lensSection(holder, 'Objects built in code', 'object literals a function returns or names');
      const grid = el('div', 'cx-entity-grid');
      built.forEach(function (entity) { grid.appendChild(entityCard(entity)); });
      section.appendChild(grid);
    }
    if (inputs.length) {
      const section = lensSection(holder, 'Component inputs', 'what each component is given');
      const grid = el('div', 'cx-entity-grid');
      inputs.forEach(function (entity) { grid.appendChild(entityCard(entity)); });
      section.appendChild(grid);
    }
    if (!lens.entities.length) holder.appendChild(el('p', 'cx-muted', 'No data types, object shapes or component inputs were found in the files read.'));
    lens.notes.forEach(function (note) { holder.appendChild(el('p', 'cx-muted', 'Bounded: ' + note + '.')); });
    paintLensSelection();
  }

  // Data flow: from one entry point, the steps, state and endpoints its data reaches.
  function flowEntryId(lens) {
    if (view.flowEntry && lens.paths[view.flowEntry]) return view.flowEntry;
    return lens.entries.length ? lens.entries[0].id : null;
  }
  function renderFlow() {
    const holder = $('cx-flow');
    holder.replaceChildren();
    const picker = $('cx-flow-entry');
    picker.replaceChildren();
    const data = lenses();
    if (!data) { picker.hidden = true; lensUnavailable(holder); return; }
    const lens = data.flow;
    const chosen = flowEntryId(lens);
    picker.hidden = !lens.entries.length;
    lens.entries.forEach(function (entry) {
      const option = el('option', '', entry.label);
      option.value = entry.id;
      option.selected = entry.id === chosen;
      picker.appendChild(option);
    });
    if (!chosen) {
      const empty = el('div', 'cx-empty');
      empty.appendChild(el('h2', '', 'No entry point found'));
      lens.notes.forEach(function (note) { empty.appendChild(el('p', '', note)); });
      holder.appendChild(empty);
      return;
    }
    const entry = lens.entries.find(function (item) { return item.id === chosen; });
    holder.appendChild(el('p', 'cx-lens-summary', 'Data entering at ' + entry.label + ' (found from ' + entry.reason + '), and every step, state and endpoint it reaches. Read top to bottom; each arrow says what it carries.'));
    const path = lens.paths[chosen];
    const nodeById = {};
    lens.nodes.forEach(function (node) { nodeById[node.id] = node; });
    const edgeById = {};
    lens.edges.forEach(function (edge) { edgeById[edge.id] = edge; });
    // Two nodes fit side by side even in a narrow panel, so one layer does not read as a sequence.
    const available = lensWidth('cx-flow');
    const nodeWidth = Math.round(Math.min(240, Math.max(170, (available - 36) / 2)));
    const nodes = path.nodes.filter(function (id) { return nodeById[id]; }).map(function (id) {
      const node = nodeById[id];
      return { id: id, w: nodeWidth, h: 54 + (node.conversions.length ? 18 : 0), rank0: node.kind === 'source' ? -1 : 0 };
    });
    const edges = path.edges.map(function (id) { return edgeById[id]; }).filter(Boolean);
    const stacked = stackLayout(nodes, edges.map(function (edge) { return { from: edge.from, to: edge.to }; }), available, { gapY: 70 });
    const boxes = stacked.positions;
    const parts = lensWorld(stacked.width + 4, stacked.height + 4);
    drawLinks(parts.layer, edges.map(function (edge) {
      return { id: edge.id, from: edge.from, to: edge.to, label: edge.inferred ? '(by name) ' + (edge.label || '') : edge.label, dashed: edge.kind === 'error' || edge.kind === 'reads' || Boolean(edge.inferred), kind: edge.kind + (edge.inferred ? ' inferred' : '') };
    }), boxes, { down: true });
    nodes.forEach(function (item) {
      const node = nodeById[item.id], spot = boxes[item.id];
      const card = button('cx-flow-node ' + node.kind + (node.category ? ' c-' + node.category : ''), '', function () { pickLens('flow', node.id); });
      card.dataset.lensItem = node.id;
      card.style.transform = 'translate(' + spot.x + 'px, ' + spot.y + 'px)';
      card.style.width = spot.w + 'px';
      card.style.height = spot.h + 'px';
      card.appendChild(el('small', 'kind', FLOW_KIND[node.kind] + (node.category && node.kind !== 'step' ? ' · ' + node.category : '')));
      card.appendChild(el('b', '', node.label));
      if (node.detail) card.appendChild(el('span', 'detail', node.detail));
      if (node.conversions.length) card.appendChild(el('span', 'conv', '⇄ converts ' + node.conversions.length + '×'));
      parts.world.appendChild(card);
    });
    parts.layer.addEventListener('click', function (event) {
      const hit = event.target.closest('[data-lens-item]');
      if (hit && hit.dataset.lensItem) pickLens('flow-edge', hit.dataset.lensItem);
    });
    const scroller = lensScroller(parts.world);
    holder.appendChild(scroller);
    lens.notes.forEach(function (note) { holder.appendChild(el('p', 'cx-muted', note)); });
    paintLensSelection();
  }

  // Logic: one function's steps as a flowchart; the inspector reads them as sentences.
  function logicChoice(data) {
    const flows = data.logic.flows;
    if (view.logicSymbol && flows[view.logicSymbol] && model.byId[view.logicSymbol]) return view.logicSymbol;
    if (view.selected && flows[view.selected]) return view.selected;
    const entry = data.flow.entries.find(function (item) { return item.symbol && flows[item.symbol]; });
    if (entry) return entry.symbol;
    const ids = Object.keys(flows).filter(function (id) { return model.byId[id]; });
    return ids.length ? ids[0] : null;
  }
  function renderLogic() {
    const holder = $('cx-logic');
    holder.replaceChildren();
    const picker = $('cx-logic-fn');
    picker.replaceChildren();
    const data = lenses();
    if (!data) { picker.hidden = true; lensUnavailable(holder); return; }
    const chosen = logicChoice(data);
    const ids = Object.keys(data.logic.flows).filter(function (id) { return model.byId[id]; }).sort(function (a, b) {
      const x = model.byId[a], y = model.byId[b];
      const fx = x.file || '', fy = y.file || '';
      return fx < fy ? -1 : fx > fy ? 1 : (x.start || 0) - (y.start || 0);
    });
    picker.hidden = !ids.length;
    let group = null, groupFile = null;
    ids.forEach(function (id) {
      const symbol = model.byId[id];
      if (symbol.file !== groupFile) { groupFile = symbol.file; group = document.createElement('optgroup'); group.label = symbol.file || ''; picker.appendChild(group); }
      const option = el('option', '', symbol.qualifiedName);
      option.value = id;
      option.selected = id === chosen;
      group.appendChild(option);
    });
    if (!chosen) {
      const empty = el('div', 'cx-empty');
      empty.appendChild(el('h2', '', 'No function to draw'));
      empty.appendChild(el('p', '', 'Steps are drawn for functions whose text was read in this view. Choose Full to map the whole worktree.'));
      holder.appendChild(empty);
      return;
    }
    view.logicSymbol = chosen;
    const symbol = model.byId[chosen];
    const flow = data.logic.flows[chosen];
    const head = el('div', 'cx-logic-head');
    head.appendChild(el('b', '', symbol.qualifiedName));
    head.appendChild(el('span', 'where', (symbol.file || '') + (symbol.start ? ' · lines ' + symbol.start + '–' + symbol.end : '')));
    head.appendChild(chip(flow.decisions + ' decision' + (flow.decisions === 1 ? '' : 's'), flow.decisions > 10 ? 'warn' : 'dim'));
    if (flow.truncated) head.appendChild(chip('first steps only', 'warn'));
    head.appendChild(button('cx-btn', 'Open', function () { post('cx.open', { symbol: chosen }); }, 'Open the function in the editor'));
    holder.appendChild(head);
    const chart = logicLayout(flow.steps);
    const byId = {};
    chart.nodes.forEach(function (node) { byId[node.id] = node; });
    const pad = 16;
    const parts = lensWorld(chart.width + pad * 2 + 40, chart.height + pad * 2);
    parts.world.classList.add('logic');
    const edgesLayer = svg('g', { transform: 'translate(' + pad + ' ' + pad + ')' });
    chart.edges.forEach(function (edge) {
      const from = byId[edge.from], to = byId[edge.to];
      if (!from || !to) return;
      const points = logicRoute(edge, from, to);
      edgesLayer.appendChild(svg('polyline', { points: points.map(function (p) { return p[0] + ',' + p[1]; }).join(' '), class: 'flow-line' + (edge.dashed ? ' dashed' : '') + (edge.back ? ' back' : ''), 'marker-end': 'url(#cx-lens-arrow)' }));
      if (edge.label) {
        const at = points[0];
        const spot = edge.sx !== undefined ? [points[1][0] + 6, points[1][1] - 5] : [at[0] + (edge.rx !== undefined || edge.lx !== undefined ? (edge.lx !== undefined ? -8 : 8) : 6), at[1] + (edge.rx !== undefined || edge.lx !== undefined ? -5 : 14)];
        const text = svg('text', { x: spot[0], y: spot[1], class: 'flow-label', 'text-anchor': edge.lx !== undefined ? 'end' : 'start' });
        text.textContent = edge.label.length > 28 ? edge.label.slice(0, 27) + '…' : edge.label;
        edgesLayer.appendChild(text);
      }
    });
    parts.layer.appendChild(edgesLayer);
    chart.nodes.forEach(function (node) {
      const card = button('cx-logic-node ' + node.kind + ' t-' + node.tone, '', function () { pickLens('logic-node', node.id); highlightLine(node.line); });
      card.dataset.lensItem = node.id;
      card.style.transform = 'translate(' + (node.x + pad) + 'px, ' + (node.y + pad) + 'px)';
      card.style.width = node.w + 'px';
      card.style.height = node.h + 'px';
      const text = el('span', 'text');
      node.lines.slice(0, node.kind === 'decision' ? 2 : 4).forEach(function (line) { text.appendChild(el('span', '', line)); });
      card.appendChild(text);
      card.title = node.lines.join('\n') + (node.line ? '\nline ' + node.line : '');
      if (node.line) card.dataset.line = String(node.line);
      parts.world.appendChild(card);
    });
    const scroller = lensScroller(parts.world);
    holder.appendChild(scroller);
    const start = chart.nodes[0];
    if (start) scroller.scrollLeft = Math.max(0, start.x + pad + start.w / 2 - scroller.clientWidth / 2);
    paintLensSelection();
  }
  function highlightLine(line) {
    inspector.querySelectorAll('.cx-steps li').forEach(function (item) { item.classList.toggle('lit', Boolean(line) && item.dataset.line === String(line)); });
    const lit = inspector.querySelector('.cx-steps li.lit');
    if (lit) lit.scrollIntoView({ block: 'nearest' });
  }
  /** The steps as sentences a person reads top to bottom, each with the line it is on. */
  function stepsOutline(steps, symbolId) {
    const list = el('ol', 'cx-steps');
    const add = function (depth, words, code, line, tone) {
      const item = el('li', 'd' + Math.min(depth, 6) + (tone ? ' ' + tone : ''));
      if (words) item.appendChild(el('span', 'w', words));
      if (code) item.appendChild(el('code', '', code));
      if (line) {
        item.dataset.line = String(line);
        item.appendChild(button('ln', String(line), function () { post('cx.openLine', { symbol: symbolId, line: line }); }, 'Open line ' + line));
      }
      list.appendChild(item);
    };
    const branch = function (step, depth, words) {
      add(depth, words, step.cond, step.line, 'decide');
      walk(step.then, depth + 1);
      if (!step.else) return;
      if (step.else.length === 1 && step.else[0].k === 'if') { branch(step.else[0], depth, 'Otherwise, if'); return; }
      add(depth, 'Otherwise', '', null, 'decide');
      walk(step.else, depth + 1);
    };
    const walk = function (items, depth) {
      items.forEach(function (step) {
        if (step.k === 'step') step.lines.forEach(function (entry) { add(depth, '', entry.text, entry.line, ''); });
        else if (step.k === 'if') branch(step, depth, 'If');
        else if (step.k === 'loop') { add(depth, 'Repeat', step.head, step.line, 'loop'); walk(step.body, depth + 1); }
        else if (step.k === 'switch') {
          add(depth, 'Depending on', step.subject, step.line, 'decide');
          step.cases.forEach(function (entry) {
            add(depth + 1, entry.label === 'otherwise' ? 'Otherwise' : 'When', entry.label === 'otherwise' ? '' : entry.label, entry.line, 'decide');
            walk(entry.body, depth + 2);
          });
        }
        else if (step.k === 'try') {
          add(depth, 'Try', '', step.line, '');
          walk(step.body, depth + 1);
          step.catches.forEach(function (entry) { add(depth, 'If it fails with', entry.label, entry.line, 'error'); walk(entry.body, depth + 1); });
          if (step.final) { add(depth, 'Finally', '', null, ''); walk(step.final, depth + 1); }
        }
        else if (step.k === 'return') add(depth, 'Return', step.text, step.line, 'done');
        else if (step.k === 'throw') add(depth, 'Stop with an error:', step.text, step.line, 'error');
        else add(depth, '', step.text, step.line, 'jump');
      });
    };
    walk(steps, 0);
    return list;
  }

  // The inspector for whatever is picked in a lens.
  function renderLensInspector() {
    const data = lenses();
    const item = view.lensItem;
    const eyebrow = function (label, tone) {
      const node = el('div', 'cx-ins-eyebrow');
      node.appendChild(el('span', 'cx-label', label));
      if (tone) node.appendChild(chip(tone, 'dim'));
      inspector.appendChild(node);
    };
    if (!data) { const empty = el('div', 'cx-empty'); empty.appendChild(el('h2', '', LENS_NAME[view.lens])); empty.appendChild(el('p', '', 'Nothing is drawn yet.')); inspector.appendChild(empty); return; }
    if (view.lens === 'logic' && (!item || item.kind !== 'logic-node')) {
      const symbolId = logicChoice(data);
      const flow = symbolId ? data.logic.flows[symbolId] : null;
      if (!flow) return;
      const symbol = model.byId[symbolId];
      eyebrow('Steps', symbol.kind);
      inspector.appendChild(el('div', 'cx-ins-title', symbol.qualifiedName));
      inspector.appendChild(el('div', 'cx-ins-path', (symbol.file || '') + (symbol.start ? ' · lines ' + symbol.start + '–' + symbol.end : '')));
      const actions = el('div', 'cx-ins-actions');
      actions.appendChild(button('cx-btn', 'Open', function () { post('cx.open', { symbol: symbolId }); }));
      actions.appendChild(button('cx-btn', 'Calls and callers', function () { select(symbolId, true); }));
      inspector.appendChild(actions);
      const steps = box('What it does, step by step', 'read from its text');
      steps.appendChild(stepsOutline(flow.steps, symbolId));
      inspector.appendChild(steps);
      if (symbol.callees.length) {
        const calls = box('It calls');
        const list = el('ul', 'cx-links');
        symbol.callees.forEach(function (id) {
          const callee = model.byId[id];
          if (!callee) return;
          const li = el('li');
          li.appendChild(button('go', callee.qualifiedName, function () { if (data.logic.flows[id]) { view.logicSymbol = id; view.lensItem = null; save(); renderLogic(); renderInspector(); } else select(id, true); }, data.logic.flows[id] ? 'Show its steps' : 'Show it'));
          list.appendChild(li);
        });
        calls.appendChild(list);
        inspector.appendChild(calls);
      }
      data.logic.notes.forEach(function (note) { inspector.appendChild(el('p', 'cx-muted', note)); });
      return;
    }
    if (!item) {
      const empty = el('div', 'cx-empty');
      empty.appendChild(el('h2', '', LENS_NAME[view.lens]));
      empty.appendChild(el('p', '', view.lens === 'concepts' ? 'Choose a part of the architecture or a concept to see which code it covers.'
        : view.lens === 'entities' ? 'Choose an entity to see its fields, what it links to and which functions take, return or build it.'
          : 'Choose a step, state or endpoint, or an arrow, to see what flows through it.'));
      inspector.appendChild(empty);
      return;
    }
    if (item.kind === 'layer') {
      const layer = data.concepts.layers.find(function (entry) { return entry.id === item.id; });
      if (!layer) return;
      eyebrow('Part of the code', layer.modules.length + ' files');
      inspector.appendChild(el('div', 'cx-ins-title', layer.label));
      const files = box('Files', 'and why each is here');
      const list = el('ul', 'cx-links cx-reasons');
      layer.modules.forEach(function (entry) {
        const li = el('li');
        li.appendChild(button('go', moduleName(entry.id), function () { post('cx.openModule', { module: entry.id }); }, 'Open the file'));
        li.appendChild(el('span', 'why', entry.reason));
        list.appendChild(li);
      });
      files.appendChild(list);
      inspector.appendChild(files);
      const out = data.concepts.layerLinks.filter(function (link) { return link.from === layer.id || link.to === layer.id; });
      if (out.length) {
        const calls = box('Calls with other parts');
        const callList = el('ul', 'cx-links');
        out.forEach(function (link) {
          const other = data.concepts.layers.find(function (entry) { return entry.id === (link.from === layer.id ? link.to : link.from); });
          callList.appendChild(el('li', '', (link.from === layer.id ? '→ ' : '← ') + (other ? other.label : link.to) + ' · ' + link.calls + ' call' + (link.calls === 1 ? '' : 's')));
        });
        calls.appendChild(callList);
        inspector.appendChild(calls);
      }
      return;
    }
    if (item.kind === 'concept') {
      const concept = data.concepts.concepts.find(function (entry) { return entry.id === item.id; });
      if (!concept) return;
      eyebrow('Concept', 'score ' + concept.score);
      inspector.appendChild(el('div', 'cx-ins-title', concept.label));
      const about = box('Where the word appears');
      about.appendChild(el('p', 'cx-muted', concept.symbols.length + ' declaration' + (concept.symbols.length === 1 ? '' : 's') + ' and ' + concept.modules.length + ' file name' + (concept.modules.length === 1 ? '' : 's') + ' or folder' + (concept.modules.length === 1 ? '' : 's') + ' use “' + concept.term + '”. A word in a name is a hint of what code is about, not proof of what it does.'));
      inspector.appendChild(about);
      const members = box('Declarations');
      members.appendChild(linkList(concept.symbols, 'Only file and folder names use it.'));
      inspector.appendChild(members);
      if (concept.entities.length) {
        const entities = box('Entities');
        const list = el('ul', 'cx-links');
        concept.entities.forEach(function (id) {
          const entity = data.entities.entities.find(function (entry) { return entry.id === id; });
          if (!entity) return;
          const li = el('li');
          li.appendChild(button('go', entity.name, function () { setLens('entities'); pickLens('entity', id); }, 'Show it among the entities'));
          list.appendChild(li);
        });
        entities.appendChild(list);
        inspector.appendChild(entities);
      }
      const files = box('Files');
      const fileList = el('ul', 'cx-links');
      concept.modules.forEach(function (moduleId) {
        const li = el('li');
        li.appendChild(button('go', moduleName(moduleId), function () { post('cx.openModule', { module: moduleId }); }, 'Open the file'));
        fileList.appendChild(li);
      });
      files.appendChild(fileList);
      inspector.appendChild(files);
      if (concept.related.length) {
        const related = box('Related concepts', 'shared names, files and calls');
        const list = el('div', 'cx-badges');
        concept.related.forEach(function (entry) { list.appendChild(button('cx-filter', entry.id.slice(2) + ' · ' + entry.strength, function () { pickLens('concept', entry.id); })); });
        related.appendChild(list);
        inspector.appendChild(related);
      }
      return;
    }
    if (item.kind === 'entity') {
      const entity = data.entities.entities.find(function (entry) { return entry.id === item.id; });
      if (!entity) return;
      eyebrow('Entity', entity.kind);
      inspector.appendChild(el('div', 'cx-ins-title', entity.name));
      inspector.appendChild(el('div', 'cx-ins-path', moduleName(entity.moduleId) + (entity.line ? ':' + entity.line : '') + ' · ' + entity.source));
      const actions = el('div', 'cx-ins-actions');
      if (entity.symbol) actions.appendChild(button('cx-btn', 'Open', function () { post(entity.line && model.byId[entity.symbol] && model.byId[entity.symbol].start <= entity.line && entity.line <= model.byId[entity.symbol].end ? 'cx.openLine' : 'cx.open', { symbol: entity.symbol, line: entity.line }); }));
      inspector.appendChild(actions);
      if (entity.fields.length) {
        const fields = box('Fields', entity.fields.length + '');
        const table = el('div', 'cx-field-table');
        entity.fields.forEach(function (field) {
          const row = el('div', 'row');
          row.appendChild(el('code', 'cx-fname', field.name));
          row.appendChild(el('span', 'cx-ftype', field.type || 'type not stated'));
          if (field.accessors.length) row.appendChild(el('span', 'acc', field.accessors.join('/')));
          if (field.line && entity.symbol) row.appendChild(button('ln', String(field.line), function () { post('cx.openLine', { symbol: entity.symbol, line: field.line }); }, 'Open line ' + field.line));
          table.appendChild(row);
        });
        fields.appendChild(table);
        inspector.appendChild(fields);
      }
      if (entity.values.length) {
        const values = box('Values', entity.values.length + '');
        const list = el('div', 'cx-badges');
        entity.values.forEach(function (value) { list.appendChild(el('span', 'cx-tag', value)); });
        values.appendChild(list);
        inspector.appendChild(values);
      }
      const links = data.entities.links.filter(function (link) { return link.from === entity.id || link.to === entity.id; });
      if (links.length || entity.extends.length) {
        const related = box('Links');
        const list = el('ul', 'cx-links');
        links.forEach(function (link) {
          const otherId = link.from === entity.id ? link.to : link.from;
          const other = data.entities.entities.find(function (entry) { return entry.id === otherId; });
          if (!other) return;
          const li = el('li');
          li.appendChild(el('span', 'why', link.from === entity.id ? (link.kind === 'is' ? 'is a' : 'has ' + link.label + (link.many ? ' (many)' : '')) : (link.kind === 'is' ? 'is extended by' : 'is held by ' + link.label + ' of')));
          li.appendChild(button('go', other.name, function () { pickLens('entity', other.id); }));
          list.appendChild(li);
        });
        entity.extends.filter(function (name) { return !links.some(function (link) { return link.kind === 'is' && link.from === entity.id; }); }).forEach(function (name) { list.appendChild(el('li', '', 'extends ' + name + ' (outside this view)')); });
        related.appendChild(list);
        inspector.appendChild(related);
      }
      const users = box('Used by', 'from declarations and their text');
      if (entity.usedBy.length) {
        const list = el('ul', 'cx-links');
        entity.usedBy.forEach(function (use) {
          const symbol = model.byId[use.symbol];
          if (!symbol) return;
          const li = el('li');
          li.appendChild(el('span', 'why', use.how));
          li.appendChild(button('go', symbol.qualifiedName, function () { select(symbol.id, true); }));
          list.appendChild(li);
        });
        users.appendChild(list);
      } else users.appendChild(el('p', 'cx-muted', 'No function in this view takes, returns or builds it by name.'));
      inspector.appendChild(users);
      if (entity.methods.length) {
        const methods = box('Behaviour', 'methods besides accessors');
        methods.appendChild(el('p', 'cx-muted', entity.methods.join(', ')));
        inspector.appendChild(methods);
      }
      return;
    }
    if (item.kind === 'flow' || item.kind === 'flow-edge') {
      const lens = data.flow;
      if (item.kind === 'flow-edge') {
        const edge = lens.edges.find(function (entry) { return entry.id === item.id; });
        if (!edge) return;
        const from = lens.nodes.find(function (node) { return node.id === edge.from; });
        const to = lens.nodes.find(function (node) { return node.id === edge.to; });
        eyebrow('What flows', edge.kind);
        const title = el('div', 'cx-ins-title');
        title.appendChild(button('cx-ref', from ? from.label : edge.from, function () { pickLens('flow', edge.from); }));
        title.appendChild(document.createTextNode(' → '));
        title.appendChild(button('cx-ref', to ? to.label : edge.to, function () { pickLens('flow', edge.to); }));
        inspector.appendChild(title);
        const carries = box('It carries', edge.kind === 'call' ? 'parameter ← argument → where the result goes' : '');
        if (edge.inferred) carries.appendChild(el('p', 'cx-muted', 'Matched by name in the text: the language service did not resolve this call, so it may be a different function with the same name.'));
        carries.appendChild(edge.label ? el('code', 'cx-carries', edge.label) : el('p', 'cx-muted', 'The text does not say what is passed here.'));
        inspector.appendChild(carries);
        if (edge.line && from && from.symbol) {
          const actions = el('div', 'cx-ins-actions');
          actions.appendChild(button('cx-btn', 'Open line ' + edge.line, function () { post('cx.openLine', { symbol: from.symbol, line: edge.line }); }));
          inspector.appendChild(actions);
        }
        return;
      }
      const node = lens.nodes.find(function (entry) { return entry.id === item.id; });
      if (!node) return;
      eyebrow(FLOW_KIND[node.kind], node.category || '');
      inspector.appendChild(el('div', 'cx-ins-title', node.label));
      if (node.detail) inspector.appendChild(el('div', 'cx-ins-path', node.detail));
      const actions = el('div', 'cx-ins-actions');
      if (node.symbol && model.byId[node.symbol]) {
        actions.appendChild(button('cx-btn', 'Open', function () { post('cx.open', { symbol: node.symbol }); }));
        if (data.logic.flows[node.symbol]) actions.appendChild(button('cx-btn', 'Its steps', function () { view.logicSymbol = node.symbol; view.lensItem = null; setLens('logic'); }));
      }
      inspector.appendChild(actions);
      const incoming = lens.edges.filter(function (edge) { return edge.to === node.id; });
      const outgoing = lens.edges.filter(function (edge) { return edge.from === node.id; });
      const listOf = function (title, edges, other) {
        if (!edges.length) return;
        const section = box(title);
        const list = el('ul', 'cx-links cx-reasons');
        edges.slice(0, 30).forEach(function (edge) {
          const target = lens.nodes.find(function (entry) { return entry.id === edge[other]; });
          const li = el('li');
          li.appendChild(button('go', target ? target.label : edge[other], function () { pickLens('flow', edge[other]); }));
          if (edge.label) li.appendChild(el('span', 'why', edge.label));
          list.appendChild(li);
        });
        section.appendChild(list);
        inspector.appendChild(section);
      };
      listOf(node.kind === 'state' ? 'Written by' : 'Comes from', incoming, 'from');
      listOf(node.kind === 'state' ? 'Goes to' : 'Goes to', outgoing, 'to');
      if (node.conversions.length) {
        const conversions = box('Changes form here', 'where a value becomes another type');
        const list = el('ul', 'cx-links cx-reasons');
        node.conversions.forEach(function (conversion) {
          const li = el('li');
          if (node.symbol) li.appendChild(button('ln', String(conversion.line), function () { post('cx.openLine', { symbol: node.symbol, line: conversion.line }); }, 'Open line ' + conversion.line));
          li.appendChild(el('code', '', conversion.text));
          list.appendChild(li);
        });
        conversions.appendChild(list);
        conversions.appendChild(el('p', 'cx-muted', 'Two values that reach a comparison by different conversions can disagree; check these when a result looks wrong.'));
        inspector.appendChild(conversions);
      }
      return;
    }
    if (item.kind === 'logic-node') {
      const symbolId = logicChoice(data);
      const flow = symbolId ? data.logic.flows[symbolId] : null;
      const chart = flow ? logicLayout(flow.steps) : null;
      const node = chart ? chart.nodes.find(function (entry) { return entry.id === item.id; }) : null;
      view.lensItem = null;
      renderLensInspector();
      if (node) highlightLine(node.line);
    }
  }

  // ---- Tabs --------------------------------------------------------------------------------
  function setTab(tab) {
    view.tab = tab;
    // A Code lens tab is asked for (by a click, a message or a link): the Code lens shows it.
    if (view.lens !== 'code') { view.lens = 'code'; paintLensBar(); }
    // The walkthrough is its own reading view: it takes the inspector's room and starts at the selection.
    $('cx-main').classList.toggle('walk-mode', tab === 'walk');
    if (tab === 'walk' && model && model.walkthrough.indexOf(view.selected) >= 0) view.walk = model.walkthrough.indexOf(view.selected);
    save();
    ['graph', 'trace', 'walk', 'repo'].forEach(function (name) {
      $('cx-view-' + name).hidden = name !== tab;
      const tabButton = $('cx-tab-' + name);
      tabButton.setAttribute('aria-selected', String(name === tab));
      tabButton.tabIndex = name === tab ? 0 : -1;
    });
    if (tab === 'repo') { if (!repo.explanation && !repo.loading && !repo.error) askRepository(repo.path ? 'refresh' : 'root'); else renderRepo(); }
    if (!model) return;
    if (tab === 'graph') { renderGraph(false); }
    if (tab === 'trace') renderTrace();
    if (tab === 'walk') renderWalk();
  }

  // ---- Full render -------------------------------------------------------------------------
  function render(fresh) {
    root.dataset.loading = model ? 'false' : 'true';
    if (!model) return;
    renderHead();
    renderStatus();
    renderFilters();
    renderOutline();
    computeLayout();
    setLens(view.lens);
    renderInspector();
    $('cx-main').classList.toggle('no-outline', !view.outline);
    root.querySelector('[data-action="outline"]').setAttribute('aria-pressed', String(view.outline));
    root.querySelector('[data-action="isolate"]').setAttribute('aria-pressed', String(view.isolate));
    root.querySelector('[data-action="minimap"]').setAttribute('aria-pressed', String(view.minimap));
    root.querySelector('[data-action="gaps"]').setAttribute('aria-pressed', String(view.gapsOnly));
    $('cx-progress').hidden = !progress;
    root.style.setProperty('--cx-inspector-w', view.inspectorWidth + 'px');
  }

  // ---- Messages from the host --------------------------------------------------------------
  window.addEventListener('message', function (event) {
    const message = event.data || {};
    if (message.type === 'cx.model') {
      const fresh = !model || message.reset;
      model = index(message.model);
      if (view.modelId !== model.id && message.reset) { view.fitted = false; }
      view.modelId = model.id;
      if (message.progress !== undefined) progress = message.progress;
      stale = false;
      if (view.selected && !model.byId[view.selected]) view.selected = null;
      if (view.selectedModule && !model.moduleById[view.selectedModule]) view.selectedModule = null;
      if (view.selectedEdge && !model.edges.some(function (edge) { return edge.id === view.selectedEdge; })) view.selectedEdge = null;
      if (message.focus && model.byId[message.focus]) { view.selected = message.focus; view.selectedModule = null; view.selectedEdge = null; }
      else if (!view.selected && !view.selectedModule && model.focus) view.selected = model.focus;
      render(fresh);
      // With no change to explain, the repository itself is what there is to read; the full view is its map.
      if (fresh && !viewChosen && view.lens === 'code' && model.view !== 'full' && model.change.status === 'empty' && !model.focus && view.tab !== 'repo') setTab('repo');
      else if (view.tab === 'repo' && !repo.explanation && !repo.loading && !repo.error) askRepository(repo.path ? 'refresh' : 'root');
      if (message.focus && model.byId[message.focus]) { const symbol = model.byId[message.focus]; const rows = moduleRows(model, model.moduleById[symbol.moduleId], view).rows; centreOn(symbol.moduleId, rows.findIndex(function (row) { return row.id === symbol.id; })); }
      save();
    } else if (message.type === 'cx.progress') {
      progress = message.text || null;
      $('cx-progress').hidden = !progress;
      if (model) renderStatus();
      else $('cx-context').textContent = progress || '';
    } else if (message.type === 'cx.stale') {
      stale = true;
      if (model) renderStatus();
    } else if (message.type === 'cx.notice') {
      showNotice(String(message.text || ''), message.tone);
    } else if (message.type === 'cx.focus') {
      if (model && model.byId[message.symbol]) { setTab('graph'); select(message.symbol, true); }
    } else if (message.type === 'cx.repository') {
      // The host names the scope it is reading; the page only shows it.
      repo.path = message.path || null;
      repo.loading = message.loading === true;
      repo.explanation = repo.loading ? null : message.explanation || null;
      repo.error = repo.loading ? null : message.error || null;
      if (view.tab === 'repo') renderRepo();
    } else if (message.type === 'cx.empty') {
      root.dataset.loading = 'false';
      const context = $('cx-context');
      context.textContent = String(message.text || '');
      inspector.replaceChildren();
      const empty = el('div', 'cx-empty');
      empty.appendChild(el('h2', '', 'Nothing to explain yet'));
      empty.appendChild(el('p', '', String(message.text || '')));
      inspector.appendChild(empty);
      $('cx-progress').hidden = true;
    }
  });

  // ---- Interaction -------------------------------------------------------------------------
  let drag = null;
  canvas.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    const head = event.target.closest('[data-drag]');
    if (head && !event.target.closest('button')) {
      const id = head.dataset.drag;
      const p = positions[id];
      if (!p) return;
      drag = { kind: 'node', id: id, startX: event.clientX, startY: event.clientY, x: p.x, y: p.y, head: head, moved: false };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.target.closest('.cx-row, .cx-more, .cx-collapse, .cx-minimap, button')) return;
    const hit = event.target.closest('[data-edge]');
    if (hit) { selectEdge(hit.dataset.edge); return; }
    drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, x: view.x, y: view.y, moved: false };
    canvas.classList.add('panning');
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', function (event) {
    if (!drag) { hoverAt(event); return; }
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.kind === 'pan') {
      view.x = drag.x + dx; view.y = drag.y + dy;
      applyTransform();
    } else if (drag.kind === 'node' && drag.moved) {
      const p = positions[drag.id];
      p.x = drag.x + dx / view.zoom; p.y = drag.y + dy / view.zoom;
      const card = nodesLayer.querySelector('[data-module="' + CSS.escape(drag.id) + '"]');
      if (card) { card.classList.add('dragging'); card.style.transform = 'translate(' + p.x + 'px, ' + p.y + 'px)'; }
      renderEdges();
    }
  });
  function endDrag(event) {
    if (!drag) return;
    if (drag.kind === 'node') {
      const card = nodesLayer.querySelector('[data-module="' + CSS.escape(drag.id) + '"]');
      if (card) card.classList.remove('dragging');
      if (drag.moved) {
        view.manual[drag.id] = { x: positions[drag.id].x, y: positions[drag.id].y };
        drag.head.dataset.moved = '1';
        renderMinimap();
      }
    } else if (!drag.moved) {
      view.selected = null; view.selectedModule = null; view.selectedEdge = null;
      if (view.isolate) renderGraph(true); else paintSelection();
      renderInspector(); renderOutline();
    }
    canvas.classList.remove('panning');
    try { canvas.releasePointerCapture(event.pointerId); } catch (error) { /* already released */ }
    drag = null;
    save();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', function (event) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.0022), event.clientX, event.clientY);
    else { view.x -= event.deltaX; view.y -= event.deltaY; applyTransform(); save(); }
  }, { passive: false });

  // Inside the root, so it inherits the page's colour tokens; fixed positioning still places it.
  const tooltip = el('div', 'cx-tooltip');
  tooltip.hidden = true;
  tooltip.setAttribute('role', 'tooltip');
  root.appendChild(tooltip);
  function hoverAt(event) {
    const row = event.target.closest && event.target.closest('.cx-row');
    const id = row ? row.dataset.symbol : null;
    if (id !== hover) {
      hover = id;
      renderEdges();
    }
    if (!id || !model.byId[id]) { tooltip.hidden = true; return; }
    const symbol = model.byId[id];
    tooltip.replaceChildren();
    tooltip.appendChild(el('div', 'tt-name', symbol.qualifiedName));
    const facts = [];
    if (symbol.status !== 'unchanged') facts.push(symbol.status + ' +' + symbol.added + ' −' + symbol.removed);
    facts.push(symbol.callers.length + ' caller' + (symbol.callers.length === 1 ? '' : 's') + ' · ' + symbol.callees.length + ' callee' + (symbol.callees.length === 1 ? '' : 's'));
    if (symbol.metrics) facts.push('complexity ' + symbol.metrics.complexity + ' (' + symbol.metrics.band + ') · ' + symbol.metrics.lines + ' lines');
    if (symbol.tests.length) facts.push(symbol.tests.length + ' test reference' + (symbol.tests.length === 1 ? '' : 's'));
    facts.forEach(function (fact) { tooltip.appendChild(el('div', 'tt-dim', fact)); });
    tooltip.appendChild(el('div', 'tt-dim', 'click: inspect · double-click: open'));
    tooltip.hidden = false;
    const x = Math.min(window.innerWidth - 350, event.clientX + 16);
    const y = Math.min(window.innerHeight - 120, event.clientY + 14);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  canvas.addEventListener('pointerleave', function () { tooltip.hidden = true; if (hover) { hover = null; renderEdges(); } });

  nodesLayer.addEventListener('click', function (event) {
    const row = event.target.closest('.cx-row');
    if (row) { tooltip.hidden = true; select(row.dataset.symbol, false); }
  });
  nodesLayer.addEventListener('dblclick', function (event) {
    const row = event.target.closest('.cx-row');
    if (row) { select(row.dataset.symbol, false); post('cx.open', { symbol: row.dataset.symbol }); }
  });
  edgesLayer.addEventListener('click', function (event) {
    const hit = event.target.closest('[data-edge]');
    if (hit) selectEdge(hit.dataset.edge);
  });

  $('cx-minimap').addEventListener('pointerdown', function (event) {
    const b = bounds();
    if (!b) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pad = 40;
    const scale = Math.min(rect.width / (b.w + pad * 2), rect.height / (b.h + pad * 2));
    const offsetX = (rect.width - (b.w + pad * 2) * scale) / 2, offsetY = (rect.height - (b.h + pad * 2) * scale) / 2;
    const move = function (clientX, clientY) {
      const wx = (clientX - rect.left - offsetX) / scale + b.x - pad;
      const wy = (clientY - rect.top - offsetY) / scale + b.y - pad;
      const canvasRect = canvas.getBoundingClientRect();
      view.x = canvasRect.width / 2 - wx * view.zoom;
      view.y = canvasRect.height / 2 - wy * view.zoom;
      applyTransform();
    };
    move(event.clientX, event.clientY);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const onMove = function (inner) { move(inner.clientX, inner.clientY); };
    const onUp = function () { target.removeEventListener('pointermove', onMove); target.removeEventListener('pointerup', onUp); save(); };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    event.stopPropagation();
  });

  root.addEventListener('click', function (event) {
    const action = event.target.closest('[data-action]');
    const depth = event.target.closest('[data-depth]');
    const viewButton = event.target.closest('[data-view]');
    const tab = event.target.closest('[data-tab]');
    const lensButton = event.target.closest('[data-lens]');
    if (lensButton) { setLens(lensButton.dataset.lens); return; }
    if (tab) { setTab(tab.dataset.tab); return; }
    if (viewButton && model) {
      if (viewButton.dataset.view !== model.view) post('cx.view', { view: viewButton.dataset.view });
      viewChosen = true;
      // Choosing a view is asking to see the graph.
      if (view.tab !== 'graph') setTab('graph');
      return;
    }
    if (depth && model) {
      const value = Number(depth.dataset.depth);
      if (value !== model.intelligence.depth) post('cx.depth', { depth: value });
      return;
    }
    if (!action) {
      if (!event.target.closest('.cx-popover, .cx-attn, .cx-engine')) { const pop = root.querySelector('.cx-popover'); if (pop) pop.remove(); }
      return;
    }
    switch (action.dataset.action) {
      case 'ask': if (model) post('cx.ask', { symbol: view.selected }); break;
      case 'reindex': post('cx.reindex'); break;
      case 'zoom-in': zoomAt(1.2); break;
      case 'zoom-out': zoomAt(1 / 1.2); break;
      case 'fit': fit(); break;
      case 'relayout': view.manual = {}; save(); renderGraph(true); fit(); break;
      case 'isolate': view.isolate = !view.isolate; action.setAttribute('aria-pressed', String(view.isolate)); save(); renderGraph(true); if (view.isolate) fit(); break;
      case 'minimap': view.minimap = !view.minimap; action.setAttribute('aria-pressed', String(view.minimap)); save(); renderMinimap(); break;
      case 'outline': view.outline = !view.outline; $('cx-main').classList.toggle('no-outline', !view.outline); action.setAttribute('aria-pressed', String(view.outline)); save(); break;
      case 'gaps': view.gapsOnly = !view.gapsOnly; action.setAttribute('aria-pressed', String(view.gapsOnly)); save(); renderTrace(); break;
      case 'repo-up': if (repo.path) askRepository('up'); break;
      case 'repo-refresh': askRepository('refresh'); break;
      case 'repo-scope': askRepository('entry', Number(action.dataset.index)); break;
      case 'repo-open': setTab('graph'); post('cx.repoOpen', { index: Number(action.dataset.index), line: Number(action.dataset.line) }); break;
    }
  });

  $('cx-flow-entry').addEventListener('change', function (event) { view.flowEntry = event.target.value; view.lensItem = null; save(); renderFlow(); renderInspector(); });
  $('cx-logic-fn').addEventListener('change', function (event) { view.logicSymbol = event.target.value; view.lensItem = null; save(); renderLogic(); renderInspector(); });

  search.value = view.query || '';
  search.addEventListener('input', function () {
    view.query = search.value;
    matchAt = -1;
    save();
    renderOutline();
    if (view.tab === 'graph') { renderNodes(); renderEdges(); }
  });
  search.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && matches.length) {
      matchAt = (matchAt + 1) % matches.length;
      select(matches[matchAt], true);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      search.value = ''; view.query = ''; save(); renderOutline(); renderNodes(); renderEdges(); canvas.focus();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (!model) return;
    const typing = event.target.closest && event.target.closest('input, textarea, select');
    if (typing) return;
    const key = event.key;
    if (key === '/') { search.focus(); search.select(); event.preventDefault(); return; }
    if (event.target.closest('[data-lens]') && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const nextLens = LENSES[(LENSES.indexOf(view.lens) + (key === 'ArrowRight' ? 1 : LENSES.length - 1)) % LENSES.length];
      setLens(nextLens);
      $('cx-lens-' + nextLens).focus();
      event.preventDefault();
      return;
    }
    if (event.target.closest('[role="tab"]') && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const order = ['graph', 'trace', 'walk', 'repo'];
      const next = order[(order.indexOf(view.tab) + (key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      setTab(next);
      $('cx-tab-' + next).focus();
      event.preventDefault();
      return;
    }
    if (view.tab === 'walk') {
      if (key === 'j' || key === 'ArrowRight' || key === 'ArrowDown') { stepWalk(1); event.preventDefault(); }
      else if (key === 'k' || key === 'ArrowLeft' || key === 'ArrowUp') { stepWalk(-1); event.preventDefault(); }
      return;
    }
    if (view.lens !== 'code' || view.tab !== 'graph') return;
    if (key === '+' || key === '=') { zoomAt(1.2); event.preventDefault(); }
    else if (key === '-' || key === '_') { zoomAt(1 / 1.2); event.preventDefault(); }
    else if (key === '0' || key === 'f' || key === 'F') { fit(); event.preventDefault(); }
    else if (key === 'i' || key === 'I') { root.querySelector('[data-action="isolate"]').click(); event.preventDefault(); }
    else if (key === 'l' || key === 'L') { root.querySelector('[data-action="relayout"]').click(); event.preventDefault(); }
    else if (key === 'm' || key === 'M') { root.querySelector('[data-action="minimap"]').click(); event.preventDefault(); }
    else if (key === 'Escape') { view.selected = null; view.selectedModule = null; view.selectedEdge = null; save(); if (view.isolate) renderGraph(true); else paintSelection(); renderInspector(); renderOutline(); }
    else if (key === 'Enter' && view.selected) { post('cx.open', { symbol: view.selected }); event.preventDefault(); }
    else if (key.indexOf('Arrow') === 0) {
      if (!view.selected) { const first = model.walkthrough[0] || (model.symbols[0] && model.symbols[0].id); if (first) select(first, true); event.preventDefault(); return; }
      const direction = key === 'ArrowLeft' ? 'left' : key === 'ArrowRight' ? 'right' : key === 'ArrowUp' ? 'up' : 'down';
      const next = neighbour(model, view, direction);
      if (next) select(next, true);
      event.preventDefault();
    }
  });

  const splitter = $('cx-splitter');
  splitter.addEventListener('pointerdown', function (event) {
    splitter.classList.add('dragging');
    splitter.setPointerCapture(event.pointerId);
    const startX = event.clientX, start = view.inspectorWidth;
    const onMove = function (inner) {
      view.inspectorWidth = Math.max(280, Math.min(720, start - (inner.clientX - startX)));
      root.style.setProperty('--cx-inspector-w', view.inspectorWidth + 'px');
    };
    const onUp = function () {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      save();
      renderMinimap();
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });
  splitter.addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    view.inspectorWidth = Math.max(280, Math.min(720, view.inspectorWidth + (event.key === 'ArrowLeft' ? 24 : -24)));
    root.style.setProperty('--cx-inspector-w', view.inspectorWidth + 'px');
    save();
    event.preventDefault();
  });

  function measureFooter() {
    const nav = document.querySelector('body > .page-nav, body > nav.page-nav, body > footer');
    const height = nav ? Math.ceil(nav.getBoundingClientRect().height) : 0;
    document.body.style.setProperty('--cx-footer', height + 'px');
    root.style.setProperty('--cx-footer', height + 'px');
  }
  measureFooter();
  window.addEventListener('resize', function () { measureFooter(); renderMinimap(); if (view.tab === 'trace') renderTrace(); });
  setLens(view.lens);
  vscode.postMessage({ type: 'cx.ready' });
})();
`;

/** The page's title line for the panel tab, kept short so editor tabs stay readable. */
export function codeExplainerTitle(subject: string | null): string {
  return subject ? `Explain · ${subject}` : 'Code Explainer';
}
