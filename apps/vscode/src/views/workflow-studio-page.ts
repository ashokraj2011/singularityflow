/**
 * Workflow Studio's page: one webview that holds the person's draft of workflows, steps, agents and
 * approval groups, and turns it into one change set for the engine.
 *
 * The draft lives in the page, not the host. Every earlier designer re-rendered the whole page on
 * each click, so text being typed was lost and focus jumped; here the host sends the model once,
 * the page renders and re-renders itself, and the host only checks (`--dry-run`) and publishes.
 * The change set is computed by comparing the draft with the model it came from, so undoing an
 * edit is just editing it back, and nothing accumulates stale operations.
 */

const STUDIO_STYLE = `
.studio{display:grid;grid-template-columns:200px minmax(0,1fr);min-height:calc(100vh - 80px);gap:0}
.studio-nav{border-right:1px solid var(--sf-border-color);padding:var(--sf-space-4) var(--sf-space-3);display:flex;flex-direction:column;gap:4px}
.studio-nav .brand{font-size:11px;letter-spacing:2px;font-weight:600;color:var(--sf-accent);padding:0 var(--sf-space-2) var(--sf-space-3)}
.studio-nav button.nav-item{display:flex;justify-content:space-between;align-items:center;gap:8px;text-align:left;padding:8px 10px;border-radius:6px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.studio-nav button.nav-item[aria-current=page]{background:var(--sf-accent-quiet);font-weight:600}
.studio-nav button.nav-item:hover{background:var(--vscode-list-hoverBackground)}
.studio-nav .count{font-size:11px;opacity:.8}
.studio-nav .count.attention{background:var(--sf-wait);color:var(--vscode-editor-background);border-radius:9px;padding:0 7px;font-weight:700;opacity:1}
.studio-nav .note{margin-top:auto;font-size:11px;opacity:.75;line-height:1.5;border-top:1px solid var(--sf-border-color);padding-top:var(--sf-space-3)}
.studio-main{padding:var(--sf-space-4) var(--sf-space-5);display:flex;flex-direction:column;gap:var(--sf-space-4);min-width:0}
.studio-main h1{margin:0;font-size:22px}
.studio-main h2{margin:0;font-size:15px}
.studio-lede{margin:0;opacity:.85;max-width:760px;line-height:1.5}
.studio-card{border:1px solid var(--sf-border-color);border-radius:10px;padding:var(--sf-space-3) var(--sf-space-4);background:var(--sf-surface);display:flex;flex-direction:column;gap:var(--sf-space-2)}
.studio-row{display:flex;align-items:center;gap:var(--sf-space-2);flex-wrap:wrap}
.studio-row.spread{justify-content:space-between}
.check-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:var(--sf-space-2);align-items:center;padding:6px 0;border-top:1px solid var(--sf-border-color)}
.check-row:first-of-type{border-top:0}
.mark{width:20px;height:20px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.mark.ok{background:var(--sf-ok);color:var(--vscode-editor-background)}
.mark.wait{background:var(--sf-wait);color:var(--vscode-editor-background)}
.mark.bad{background:var(--sf-bad);color:var(--vscode-editor-background)}
.mark.dim{border:1px solid var(--sf-border-color)}
.muted{opacity:.75;font-size:12px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 8px;border-radius:12px;border:1px solid var(--sf-border-color)}
.pill.new{background:var(--sf-accent-quiet);font-weight:700}
.pill.skill{font-family:var(--vscode-editor-font-family);font-size:10px;padding:1px 6px;max-width:84px;min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block}
.rail{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rail .stop{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 8px 3px 3px;border-radius:12px;border:1px solid var(--sf-border-color)}
.avatar{width:20px;height:20px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.avatar.large{width:28px;height:28px;border-radius:14px;font-size:11px}
.blueprints{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:var(--sf-space-3)}
.blueprint{text-align:left;font:inherit;color:inherit;background:var(--sf-surface);border:1px solid var(--sf-border-color);border-radius:10px;padding:var(--sf-space-3);display:flex;flex-direction:column;gap:8px;cursor:pointer;min-height:150px}
.blueprint[aria-pressed=true]{border:2px solid var(--sf-accent)}
.lane-label{font-size:10px;letter-spacing:1px;font-weight:700;opacity:.8}
.studio.compact{grid-template-columns:56px minmax(0,1fr);min-height:0}
.studio.compact .studio-nav{padding:var(--sf-space-3) 8px;align-items:center}
.studio-nav button.nav-icon{position:relative;width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:8px;border:0;background:transparent;color:inherit;cursor:pointer}
.studio-nav button.nav-icon[aria-current=page]{background:var(--sf-accent-quiet);color:var(--sf-accent)}
.studio-nav button.nav-icon:hover{background:var(--vscode-list-hoverBackground)}
.studio-nav button.nav-icon .count{position:absolute;top:1px;right:0;font-size:9px;line-height:14px;min-width:14px;padding:0 3px;border-radius:7px}
.studio-main.board-main{padding:var(--sf-space-3) var(--sf-space-4);gap:var(--sf-space-3)}
.board-head{display:flex;justify-content:space-between;align-items:center;gap:var(--sf-space-2);flex-wrap:wrap}
.board-head .muted{max-width:520px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.crumb{background:transparent;border:0;color:var(--sf-link);padding:2px 4px;font:inherit;cursor:pointer}
.studio .crumb:hover:not(:disabled){text-decoration:underline}
.crumb-sep{opacity:.6}
.board-head select{font:inherit;font-weight:600;padding:4px 6px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border-color));background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
.board{display:grid;grid-template-columns:minmax(0,1fr) 10px var(--panel-w,380px);gap:0;height:calc(100vh - 120px);min-height:420px}
.board.panel-hidden{grid-template-columns:minmax(0,1fr) 10px 40px}
.splitter{position:relative;cursor:col-resize;touch-action:none}
.splitter::after{content:"";position:absolute;top:0;bottom:0;left:4px;width:2px;border-radius:1px;background:transparent;transition:background .12s}
.splitter:hover::after,.splitter.dragging::after,.splitter:focus-visible::after{background:var(--sf-accent)}
.splitter:focus-visible{outline:none}
.panel-strip{display:flex;flex-direction:column;align-items:center;gap:10px;padding:8px 0;border:1px solid var(--sf-border-color);border-radius:8px;background:var(--sf-surface)}
.panel-strip .strip-label{writing-mode:vertical-rl;font-family:var(--sf-font-mono,monospace);font-size:10px;letter-spacing:.14em;color:var(--sf-dim)}
.canvas{position:relative;overflow:hidden;border:1px solid var(--sf-border-color);border-radius:10px;background-color:var(--vscode-editor-background);background-image:radial-gradient(circle,color-mix(in srgb,var(--vscode-foreground) 22%,transparent) 1px,transparent 1.5px);background-size:22px 22px;cursor:grab;touch-action:none;user-select:none}
.canvas.panning{cursor:grabbing}
.canvas-world{position:absolute;left:0;top:0;transform-origin:0 0}
.edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.edge{fill:none;stroke-width:2;stroke-linejoin:round}
.edge-next{stroke:color-mix(in srgb,var(--vscode-foreground) 45%,transparent)}
.edge-send-back{stroke:var(--vscode-charts-orange,#d18616)}
.edge-decision{stroke:var(--vscode-charts-purple,#b180d7)}
.edge.dashed{stroke-dasharray:6 4}
.head-next{fill:color-mix(in srgb,var(--vscode-foreground) 45%,transparent)}
.head-send-back{fill:var(--vscode-charts-orange,#d18616)}
.head-decision{fill:var(--vscode-charts-purple,#b180d7)}
.tone-blue{--tone:var(--vscode-charts-blue,#3794ff)}
.tone-cyan{--tone:var(--vscode-terminal-ansiCyan,#11a8cd)}
.tone-green{--tone:var(--vscode-charts-green,#89d185)}
.tone-yellow{--tone:var(--vscode-charts-yellow,#cca700)}
.tone-purple{--tone:var(--vscode-charts-purple,#b180d7)}
.tone-orange{--tone:var(--vscode-charts-orange,#d18616)}
.node{position:absolute;box-sizing:border-box;border-radius:6px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 1px 0 rgba(0,0,0,.3)}
.node::before{content:"";position:absolute;left:-1px;top:-1px;bottom:-1px;width:3px;border-radius:6px 0 0 6px;background:var(--tone)}
.node:hover{border-color:color-mix(in srgb,var(--tone) 55%,var(--sf-border-color))}
.node.selected{border-color:var(--sf-accent);box-shadow:var(--sf-glow,0 0 0 1px var(--sf-accent))}
.node.match{box-shadow:0 0 0 3px var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33))}
.node.dragging{opacity:.45}
.node.drop-target{outline:2px dashed var(--sf-accent);outline-offset:4px}
.node.blocked{border-color:var(--sf-bad)}
.node-main{display:flex;flex-direction:column;gap:6px;width:100%;height:100%;box-sizing:border-box;padding:9px 12px 9px 14px;border:0;border-radius:inherit;background:transparent;color:var(--vscode-foreground);font:inherit;text-align:left;cursor:pointer;overflow:hidden}
.node-main:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
.node-head{display:flex;align-items:center;gap:7px;min-width:0;padding-right:22px}
.node-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border-radius:5px;background:color-mix(in srgb,var(--tone) 20%,transparent);color:var(--tone)}
.node-step{font-family:var(--sf-font-mono,monospace);font-size:10px;letter-spacing:.1em;font-weight:700;color:var(--sf-dim,inherit);flex:1 0 auto;white-space:nowrap}
.node-title{font-size:13px;font-weight:600;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.node-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;min-width:0}
.node-agent{display:inline-flex;align-items:center;gap:6px;min-width:0}
.node-agent .name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.node-sign{display:inline-flex;align-items:center;gap:3px;flex:none;padding:1px 6px;border-radius:3px;border:1px solid var(--sf-border-color);font-family:var(--sf-font-mono,monospace);font-size:10px}
.node-sign.none{border-style:dashed;opacity:.75}
.node-sign.bad{background:var(--sf-bad);border-color:var(--sf-bad);color:var(--vscode-editor-background)}
.node-skills{display:inline-flex;align-items:center;gap:3px;flex:none;padding:1px 6px;border-radius:3px;border:1px solid var(--sf-border-color);font-family:var(--sf-font-mono,monospace);font-size:10px}
.seeded-steps{display:flex;flex-direction:column;gap:8px;padding-left:20px}
.seeded-steps .studio-card{margin-top:6px}
.node-asks{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:3px;border:1px solid var(--sf-border-color);font-family:var(--sf-font-mono,monospace);font-size:10px;font-weight:700;color:var(--sf-dim,inherit)}
.node-after{margin-top:auto;display:flex;align-items:center;gap:4px;min-width:0;padding-top:7px;border-top:1px solid var(--sf-border-color);overflow:hidden}
.node-after .lane{flex:none;font-family:var(--sf-font-mono,monospace);font-size:9px;letter-spacing:.12em;font-weight:700;color:var(--sf-faint,var(--sf-dim));margin-right:2px}
.chip{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;padding:1px 6px;border-radius:3px;border:1px solid var(--sf-border-color);font-family:var(--sf-font-mono,monospace);font-size:10px;line-height:16px;white-space:nowrap}
.chip .chip-text{overflow:hidden;text-overflow:ellipsis}
.chip-route{color:var(--sf-dim,inherit)}
.chip-decision{border-color:color-mix(in srgb,var(--vscode-charts-purple,#b180d7) 60%,transparent);color:var(--vscode-charts-purple,#b180d7)}
.chip-back{flex:none;max-width:45%;border-color:color-mix(in srgb,var(--vscode-charts-orange,#d18616) 60%,transparent);color:var(--vscode-charts-orange,#d18616)}
.node.collapsed .node-main{flex-direction:row;align-items:center;gap:7px;padding:0 28px 0 12px}
.node.collapsed .node-icon{width:20px;height:20px}
.node-num{flex:none;font-family:var(--sf-font-mono,monospace);font-size:11px;font-weight:700;color:var(--sf-dim,inherit)}
.node.collapsed .node-title{flex:1;min-width:0;font-size:12px;-webkit-line-clamp:1;white-space:nowrap;text-overflow:ellipsis;display:block}
.node-marks{display:inline-flex;align-items:center;gap:3px;flex:none}
.mark-chip{display:inline-flex;align-items:center;gap:2px;font-family:var(--sf-font-mono,monospace);font-size:10px;color:var(--sf-dim,inherit)}
.mark-chip.bad{color:var(--sf-bad)}
.mark-chip.decision{color:var(--vscode-charts-purple,#b180d7)}
.mark-chip.back{color:var(--vscode-charts-orange,#d18616)}
.chip-action{flex:none;max-width:45%;border-color:color-mix(in srgb,var(--sf-link) 55%,transparent);color:var(--sf-link)}
.mark-chip.action{color:var(--sf-link)}
.node-fold{position:absolute;top:7px;right:6px;z-index:1;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--sf-dim,inherit);cursor:pointer}
.node.collapsed .node-fold{top:9px}
.studio .canvas .node-fold:hover:not(:disabled){border-color:var(--sf-border-color);color:var(--vscode-foreground);background:var(--sf-surface-raised,transparent)}
.node-tools{position:absolute;top:-31px;right:10px;display:none;gap:2px;padding:2px;border-radius:6px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 2px 6px rgba(0,0,0,.25)}
.node:hover .node-tools,.node-tools:focus-within{display:flex}
.node-tools button,.zoom-controls button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.node-tools button:disabled{opacity:.35;cursor:default}
.finish{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;border-radius:18px;border:1px dashed var(--sf-border-color);background:var(--sf-surface);font-size:12px;font-weight:600}
.diamond-node{position:absolute;box-sizing:border-box;width:22px;height:22px;margin:-11px 0 0 -11px;padding:0;transform:rotate(45deg);border-radius:4px;border:2px solid var(--vscode-charts-purple,#b180d7);background:color-mix(in srgb,var(--vscode-charts-purple,#b180d7) 30%,var(--vscode-editor-background));cursor:pointer}
.diamond-node[aria-pressed=true]{box-shadow:0 0 0 4px color-mix(in srgb,var(--vscode-charts-purple,#b180d7) 35%,transparent)}
.diamond-caption{position:absolute;transform:translateX(-50%);width:88px;font-size:10px;line-height:1.25;text-align:center;opacity:.9;pointer-events:none}
.edge-label{position:absolute;transform:translate(-50%,-50%);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;font-size:10.5px;padding:2px 8px;border-radius:10px;border:1px solid var(--tone);background:var(--vscode-editor-background);color:var(--vscode-foreground);cursor:pointer}
.edge-label.tone-send-back{--tone:var(--vscode-charts-orange,#d18616)}
.edge-label.tone-decision{--tone:var(--vscode-charts-purple,#b180d7)}
.edge-label.stub{border-style:dashed;max-width:200px}
.tool-rail{position:absolute;left:10px;top:10px;z-index:2;display:flex;flex-direction:column;gap:4px;padding:5px;border-radius:10px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 2px 10px rgba(0,0,0,.22)}
.tool{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer}
.tool[aria-pressed=true]{background:var(--sf-accent-quiet);color:var(--sf-accent)}
.tool:disabled{opacity:.35;cursor:default}
.zoom-controls{position:absolute;right:10px;bottom:10px;z-index:2;display:flex;align-items:center;gap:2px;padding:3px;border-radius:9px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 2px 10px rgba(0,0,0,.22)}
.zoom-level{min-width:42px;text-align:center;font-size:11px;font-variant-numeric:tabular-nums}
.canvas-legend{position:absolute;left:58px;bottom:12px;z-index:2;max-width:min(620px,calc(100% - 230px));display:flex;flex-wrap:wrap;gap:5px 14px;padding:8px 12px;border-radius:6px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 2px 10px rgba(0,0,0,.22);font-size:11px}
.legend{display:inline-flex;align-items:center;gap:5px}
.legend-dot{width:9px;height:9px;border-radius:3px;background:var(--tone)}
.legend-dot.diamond-dot{transform:rotate(45deg);border-radius:2px}
.legend-line{width:16px;height:0;border-top:2px solid var(--tone)}
.legend.hint-text{opacity:.75;font-style:italic}
.find-box{position:absolute;left:62px;top:10px;z-index:2;display:flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;border-radius:9px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 2px 10px rgba(0,0,0,.22)}
.find-box input{font:inherit;width:200px;padding:4px 6px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border-color));background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
.board .inspector{position:static;overflow-y:auto;min-height:0}
.inspector.properties{padding:0;gap:0;background:var(--sf-surface)}
.prop-title{display:flex;align-items:center;gap:10px;padding:10px 10px 10px var(--sf-space-3);border-bottom:1px solid var(--sf-border-color);position:sticky;top:0;z-index:1;background:var(--sf-surface)}
.prop-title>div{flex:1;min-width:0}
.prop-title h2{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-family:var(--vscode-font-family);font-size:15px;font-weight:700;letter-spacing:0;text-transform:none;line-height:1.3}
.prop-tools{display:flex;align-items:center;gap:2px;flex:none}
.prop-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:inherit;cursor:pointer}
.prop-icon:disabled{opacity:.35;cursor:default}
.studio .prop-icon:hover:not(:disabled){border-color:var(--sf-border-color);background:var(--sf-surface-raised,transparent);box-shadow:none}
.prop-title h2{font-size:14px;margin:2px 0 0}
.prop-section{border-bottom:1px solid var(--sf-border-color)}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px var(--sf-space-3)}
.section-toggle{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:2px 0;border:0;background:transparent;color:inherit;font-family:var(--sf-font-mono,monospace);font-weight:700;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;text-align:left;cursor:pointer;white-space:nowrap}
.section-toggle .summary{margin-left:auto;font-family:var(--vscode-font-family);font-size:11.5px;font-weight:400;letter-spacing:0;text-transform:none;opacity:.7;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.chevron{display:inline-block;width:12px;opacity:.8}
.prop-body{display:flex;flex-direction:column;gap:var(--sf-space-2);padding:0 var(--sf-space-3) var(--sf-space-3)}
.prop-body.decision-body{padding-top:var(--sf-space-3)}
.prop-actions{display:flex;flex-wrap:wrap;gap:6px;padding:var(--sf-space-3)}
.prop-link{text-align:left;font:inherit;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--sf-border-color);background:transparent;color:inherit;cursor:pointer}
.switch{position:relative;display:inline-flex;flex:none;width:30px;height:16px}
.switch input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1}
.switch .slider{width:100%;height:100%;border-radius:8px;background:color-mix(in srgb,var(--vscode-foreground) 25%,transparent);transition:background .15s}
.switch .slider::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:6px;background:var(--vscode-editor-background);transition:transform .15s}
.switch input:checked+.slider{background:var(--sf-accent)}
.switch input:checked+.slider::after{transform:translateX(14px)}
.switch input:focus-visible+.slider{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
.agent-row{display:flex;align-items:flex-start;gap:8px}
.meter{display:flex;gap:3px}
.meter span{flex:1;height:5px;border-radius:3px;background:color-mix(in srgb,var(--vscode-foreground) 18%,transparent)}
.meter span.on{background:var(--vscode-charts-orange,#d18616)}
.icon{flex:none}
.studio .canvas button,.studio .section-toggle,.studio .crumb,.studio-nav button.nav-icon,.studio .prop-link{min-height:0;max-width:none;letter-spacing:normal;box-shadow:none}
.studio .section-toggle,.studio .prop-link,.studio .node-main{justify-content:flex-start}
.studio .node-main{align-items:stretch}
.studio .canvas button:hover:not(:disabled),.studio .section-toggle:hover:not(:disabled),.studio .crumb:hover:not(:disabled),.studio .prop-link:hover:not(:disabled){box-shadow:none}
.studio .node-main:hover:not(:disabled),.studio .section-toggle:hover:not(:disabled),.studio .crumb:hover:not(:disabled){background:transparent}
.studio .tool:hover:not(:disabled),.studio .node-tools button:hover:not(:disabled),.studio .zoom-controls button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.18))}
.studio .tool[aria-pressed=true],.studio .tool[aria-pressed=true]:hover:not(:disabled){background:var(--sf-accent-quiet);color:var(--sf-accent)}
.studio .prop-link:hover:not(:disabled){background:var(--vscode-list-hoverBackground)}
.studio .edge-label:hover:not(:disabled){background:color-mix(in srgb,var(--tone) 18%,var(--vscode-editor-background))}
.studio .diamond-node:hover:not(:disabled){background:color-mix(in srgb,var(--vscode-charts-purple,#b180d7) 45%,var(--vscode-editor-background))}
.studio .diamond-node:active:not(:disabled){transform:rotate(45deg)}
.studio .edge-label:active:not(:disabled){transform:translate(-50%,-50%)}
.studio .canvas button:active:not(:disabled):not(.diamond-node):not(.edge-label){transform:none}
.inspector{border:1px solid var(--sf-border-color);border-radius:10px;padding:var(--sf-space-3);display:flex;flex-direction:column;gap:var(--sf-space-3);position:sticky;top:8px}
.field{display:flex;flex-direction:column;gap:4px}
.field label,.field .label{font-size:12px;font-weight:600}
.studio .field>label,.studio .field>.label,.studio .field>legend.label{font-family:var(--sf-font-mono,monospace);font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--sf-dim,inherit)}
.field input[type=text],.field input[type=email],.field select,.field textarea{font:inherit;padding:6px 8px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border-color));background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
.field textarea{min-height:110px;resize:vertical}
.field .hint{font-size:11px;opacity:.8;line-height:1.4}
.studio .field>.hint{font-size:11.5px;font-weight:400;opacity:1;color:var(--sf-dim,inherit)}
.checks{display:flex;flex-direction:column;gap:4px}
.checks label{display:flex;gap:6px;align-items:center;font-size:13px;font-weight:400}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--sf-space-2)}
.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--sf-space-2)}
.callout{font-size:12px;line-height:1.45;padding:8px 10px;border-radius:6px;border:1px solid var(--sf-border-color)}
.callout.wait{border-color:var(--sf-wait)}
.callout.bad{border-color:var(--sf-bad)}
.callout.ok{border-color:var(--sf-ok)}
.agents-grid,.groups-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--sf-space-3)}
.member{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 4px 2px 8px;border-radius:12px;border:1px solid var(--sf-border-color)}
.member button{padding:0 6px;font-size:11px}
.change-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.studio .artifact-group{display:flex;flex-direction:column;gap:4px;padding:6px 0 0;border-top:1px solid var(--sf-border-color)}
.artifact-list{list-style:none;margin:0 0 6px;padding:0;border:1px solid var(--sf-border-color);border-radius:8px}
.artifact-row{display:grid;grid-template-columns:minmax(150px,1fr) minmax(0,2fr) auto;gap:var(--sf-space-2);align-items:center;padding:5px 10px;border-top:1px solid var(--sf-border-color)}
.artifact-row:first-child{border-top:0}
.artifact-name{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}
.artifact-users{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.artifact-group[hidden],.artifact-list[hidden],.artifact-row[hidden]{display:none}
.set-members{margin:0;padding-left:18px;font-size:12.5px}
@media (max-width:640px){.artifact-row{grid-template-columns:minmax(0,1fr) auto}.artifact-users{grid-column:1/-1;grid-row:2;white-space:normal}}
.change-list li{border:1px solid var(--sf-border-color);border-radius:8px;padding:8px 10px;font-size:13px}
.diff{font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre;overflow:auto;max-height:320px;border:1px solid var(--sf-border-color);border-radius:6px;padding:8px;margin:0}
.diff .add{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.diff .del{color:var(--vscode-gitDecoration-deletedResourceForeground,#c74e39)}
.studio-status{min-height:1.2em;font-size:12px}
.action-box{border:1px solid var(--sf-border-color);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px}
.trigger-row{display:flex;flex-wrap:wrap;gap:4px 14px}
.trigger-row label{display:flex;gap:6px;align-items:center;font-size:13px;font-weight:400}
.kind-choices{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:var(--sf-space-2)}
.studio .kind-choice{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:4px;min-height:0;max-width:none;text-align:left;font:inherit;letter-spacing:normal;color:inherit;background:var(--sf-surface);border:1px solid var(--sf-border-color);border-radius:8px;padding:8px 10px;box-shadow:none;cursor:pointer}
.studio .kind-choice[aria-checked=true]{border:2px solid var(--sf-accent);padding:7px 9px}
.studio .kind-choice:hover:not(:disabled){background:var(--vscode-list-hoverBackground);box-shadow:none}
.studio .kind-choice:active:not(:disabled){transform:none}
.studio .kind-choice:disabled{opacity:.55;cursor:not-allowed}
.targets-grid{display:flex;flex-direction:column;gap:var(--sf-space-3);max-width:1100px}
.secrets{display:flex;flex-direction:column;gap:6px}
.secret-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:var(--sf-space-2);align-items:center;font-size:12px}
.secret-row code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.secret-state{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--sf-border-color);white-space:nowrap}
.secret-state.stored,.secret-state.environment{border-color:var(--sf-ok)}
.secret-state.missing{border-color:var(--sf-wait)}
.test-box{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--sf-border-color);padding-top:8px}
.test-box .checks{margin:0;padding-left:0;list-style:none;font-size:12px}
.bad-text{color:var(--sf-bad)}
.test-box select{font:inherit;padding:4px 6px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border-color));background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
.decision-box{border:1px solid var(--sf-border-color);border-radius:8px;padding:8px 10px;margin:0;display:flex;flex-direction:column;gap:6px}
.decision-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.preview-text{font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre-wrap;overflow:auto;max-height:280px;border:1px solid var(--sf-border-color);border-radius:6px;padding:8px;margin:0}
.decision-row select,.decision-row input[type=text]{font:inherit;padding:4px 6px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border-color));background:var(--vscode-input-background);color:var(--vscode-input-foreground);max-width:100%}
/* The Studio is a tool surface: it takes the whole editor, and the shared footer becomes one quiet line. */
body:has(#studio-root){max-width:none;padding:0 12px}
body:has(#studio-root) .page-nav{margin:0;padding:5px 2px 7px;font-size:.72rem;gap:.15rem 1.1rem}
body:has(#studio-root) .page-nav .link,body:has(#studio-root) .page-nav .nav-current{min-height:0;padding:0;font-size:.72rem;font-weight:500}
.board-head .studio-status{margin-left:auto;min-height:0}
@media (max-width:900px){.board,.board.panel-hidden{grid-template-columns:minmax(0,1fr)}.splitter{display:none}}
@media (max-width:900px){.studio,.studio.compact{grid-template-columns:minmax(0,1fr);grid-template-rows:auto 1fr}.studio-nav,.studio.compact .studio-nav{border-right:0;border-bottom:1px solid var(--sf-border-color);flex-direction:row;flex-wrap:wrap}.studio-nav .note{display:none}.board{grid-template-columns:minmax(0,1fr);height:auto}.canvas{height:420px}.inspector{position:static}}
`;

/**
 * The page's logic. Plain browser JavaScript: it renders with DOM calls (text is never parsed as
 * HTML), keeps the draft, and exposes its pure parts on `window.__workflowStudio` so they can be
 * exercised without a browser.
 */
/** A configuration proposal branch, as `workflow proposals --json` names one. */
export const PROPOSAL_BRANCH = /^sflow\/config-change\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const MAX_LISTED_PROPOSALS = 100;
/** The sections the page can be opened at, for screens that send a person to one. */
export const STUDIO_FOCUS_VIEWS = Object.freeze(['home', 'agents', 'skills', 'artifacts', 'library', 'people', 'integrations', 'changes'] as const);
export type StudioFocusView = typeof STUDIO_FOCUS_VIEWS[number];

/** A configuration proposal as the Changes view lists it: names and counts, never file content. */
export interface StudioProposalSummary {
  branch: string; proposalCommit: string; valid: boolean; merged: boolean;
  workflows: Array<{ id: string; governs: string | null; change: string; label: string | null }>;
  files: number; invalidFiles: string[]; failure: string | null;
}

/** What `workflow proposals --json` lists, bounded to the fields the page shows. */
export function proposalSummaries(listed: unknown): StudioProposalSummary[] {
  const text = (value: unknown, limit = 300): string | null => (typeof value === 'string' && value.trim() ? value.slice(0, limit) : null);
  return (Array.isArray(listed) ? listed : []).slice(0, MAX_LISTED_PROPOSALS).flatMap((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const branch = text(entry.branch, 260);
    const proposalCommit = text(entry.proposalCommit, 64);
    if (!branch || !PROPOSAL_BRANCH.test(branch) || !proposalCommit) return [];
    const workflows = (Array.isArray(entry.workflows) ? entry.workflows : []).slice(0, 50).map((item) => {
      const workflow = (item ?? {}) as Record<string, unknown>;
      return { id: text(workflow.id, 80) ?? '?', governs: text(workflow.governs, 20), change: text(workflow.change, 20) ?? 'changed', label: text(workflow.label, 120) };
    });
    return [{
      branch, proposalCommit, valid: entry.valid === true, merged: entry.merged === true, workflows,
      files: Array.isArray(entry.changedFiles) ? entry.changedFiles.length : 0,
      invalidFiles: (Array.isArray(entry.invalidFiles) ? entry.invalidFiles : []).filter((name): name is string => typeof name === 'string').slice(0, 10),
      failure: text((entry.failure as { message?: unknown } | undefined)?.message)
    }];
  });
}

export const WORKFLOW_STUDIO_SCRIPT = String.raw`
(function () {
  'use strict';
  var vscodeApi = window.__sfVscode;
  var state = { model: null, draft: null, view: 'home', workflow: null, step: null, decision: null, plan: null, planKey: null, busy: null, error: null, wizard: null, agentForm: null, status: '', panel: null, sections: {}, canvas: {}, focusKey: null, collapsed: {}, panelWidth: 380, panelHidden: false, legend: false, confirms: {}, confirmSeq: 0, returnTo: null };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function kebab(text) { return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
  function initials(label) { var parts = String(label || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/); return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '?')[1] || '')).toUpperCase(); }

  // ---- The draft and the change set ---------------------------------------------------------

  function initialDraft(model) {
    var draft = { workflows: {}, steps: {}, phases: {}, agents: {}, groups: {}, integrations: {}, order: [], imports: [], templates: {}, artifactSets: {}, skills: {} };
    (model.workflows || []).forEach(function (workflow) {
      draft.order.push(workflow.id);
      draft.workflows[workflow.id] = { id: workflow.id, label: workflow.label, description: workflow.description || '', phases: workflow.phases.slice(), reworkLoops: clone(workflow.reworkLoops || []), decisions: clone(workflow.decisions || []), isNew: false, installFrom: null, readOnly: Boolean(workflow.readOnly),
        skills: clone(workflow.skills || []), plannedClaims: workflow.plannedClaims && workflow.plannedClaims.declared ? clone(workflow.plannedClaims.declared) : null };
      draft.steps[workflow.id] = {};
      (workflow.steps || []).forEach(function (step) {
        draft.steps[workflow.id][step.id] = { approval: approvalDraft(step.approval), inputs: (step.inputs || []).slice(), output: step.output, views: (step.views || []).slice(), clarification: step.clarification || 'off', overridden: Boolean(step.overridden), authoringSkill: step.authoringSkill || null, authoringSkillSetByWorkflow: Boolean(step.authoringSkillSetByWorkflow), generatedByEngine: Boolean(step.generatedByEngine), convergence: Boolean(step.convergence), compiledSkill: Boolean(step.compiledSkill), afterStep: clone(step.afterStep || []), afterStepSetByWorkflow: Boolean(step.afterStepSetByWorkflow),
          template: step.template || null, optionalInputs: (step.optionalInputs || []).slice(), definesClauses: Boolean(step.definesClauses) };
      });
    });
    (model.phases || []).forEach(function (phase) {
      draft.phases[phase.id] = { id: phase.id, label: phase.label, output: phase.output, baseOutput: phase.output, views: (phase.views || []).slice(), clarification: phase.clarification || 'off', agent: phase.agent, authoringSkill: phase.authoringSkill || null, generatedByEngine: Boolean(phase.generatedByEngine), convergence: Boolean(phase.convergence), compiledSkill: Boolean(phase.compiledSkill), usedBy: (phase.usedBy || []).slice(), isNew: false, fromBlueprint: null, approval: approvalDraft(phase.approval), inputs: (phase.inputs || []).slice(), afterStep: clone(phase.afterStep || []),
        template: phase.template || null, artifactSet: phase.artifactSet || null, optionalInputs: (phase.optionalInputs || []).slice(),
        artifactFile: phase.artifact ? String(phase.artifact).split('/').pop() : null };
    });
    // Templates and artifact sets as the model lists them; edits change the draft copies.
    (model.templates || []).forEach(function (template) {
      draft.templates[template.path] = { path: template.path, scope: template.scope, catalogId: template.catalogId || null, label: template.label || null,
        content: template.content, tooLarge: Boolean(template.tooLarge), usedBy: (template.usedBy || []).slice(), isNew: false };
    });
    (model.artifactSets || []).forEach(function (set) {
      draft.artifactSets[set.id] = { id: set.id, primary: set.primary, members: clone(set.members || []), usedBy: (set.usedBy || []).slice(), isNew: false };
    });
    (model.agents || []).forEach(function (agent) {
      draft.agents[agent.id] = { id: agent.id, label: agent.label, description: agent.description, tools: agent.tools.slice(), views: agent.views.slice(), instructions: agent.instructions || '', scope: agent.scope, isNew: false, role: null, skills: clone(agent.skills || []) };
    });
    // The skill master: named instructions attached at workflow or agent scope.
    (model.skills || []).forEach(function (skill) {
      draft.skills[skill.id] = { id: skill.id, label: skill.label, description: skill.description, instructions: skill.instructions, loading: skill.loading || 'eager', isNew: false };
    });
    (model.groups || []).forEach(function (group) {
      draft.groups[group.id] = { id: group.id, label: group.label, members: clone(group.members || []), status: group.status, isNew: false };
    });
    // Integration targets as written: addresses and secret names, never secret values.
    ((model.integrations && model.integrations.targets) || []).forEach(function (target) {
      var copy = clone(target); delete copy.id; draft.integrations[target.id] = copy;
    });
    draft.epics = epicsDraftFrom(model.epics);
    return draft;
  }

  /** Epic workflows and their steps as the page edits them; null when the repository has no portfolio. */
  function epicsDraftFrom(epics) {
    if (!epics) return null;
    var draft = { templatesRoot: epics.templatesRoot, order: [], workflows: {}, steps: {} };
    function stepDraft(step) { return { id: step.id, label: step.label, agents: step.agents.slice(), lanes: step.lanes.slice(), views: step.views.slice(),
      approval: { on: step.approval.mode !== 'none', groups: step.approval.authorities.slice(), minimum: step.approval.minimum || 1, chain: Boolean(step.approval.chain) },
      outputs: clone(step.outputs), checklist: step.checklist || 0, isNew: false, local: true }; }
    (epics.workflows || []).forEach(function (workflow) {
      draft.order.push(workflow.id);
      draft.workflows[workflow.id] = { id: workflow.id, label: workflow.label, description: workflow.description || '', phases: workflow.phases.slice(), lifecycleMode: workflow.lifecycleMode, packs: workflow.packs || 0, isNew: false, copyOf: null,
        localSteps: Object.fromEntries(Object.entries(workflow.localSteps || {}).map(function (entry) { return [entry[0], stepDraft(entry[1])]; })) };
    });
    (epics.steps || []).forEach(function (step) {
      draft.steps[step.id] = { id: step.id, label: step.label, agents: step.agents.slice(), lanes: step.lanes.slice(), views: step.views.slice(),
        approval: { on: step.approval.mode !== 'none', groups: step.approval.authorities.slice(), minimum: step.approval.minimum || 1, chain: Boolean(step.approval.chain) },
        outputs: step.outputs.map(function (output) { return clone(output); }), checklist: step.checklist || 0, isNew: false };
    });
    return draft;
  }
  /** A kept draft from an older Studio may lack collections added since; they start from the configuration. */
  function withDraftDefaults(draft) {
    var fresh = initialDraft(state.model);
    Object.keys(fresh).forEach(function (key) { if (draft[key] === undefined) draft[key] = fresh[key]; });
    // A draft saved before agents listed their skills keeps the skills they have, not none.
    Object.keys(draft.agents || {}).forEach(function (id) {
      if (draft.agents[id].skills === undefined) draft.agents[id].skills = fresh.agents[id] ? clone(fresh.agents[id].skills) : [];
    });
    Object.keys(draft.workflows || {}).forEach(function (id) {
      if (draft.workflows[id].skills === undefined) draft.workflows[id].skills = fresh.workflows[id] ? clone(fresh.workflows[id].skills) : [];
    });
    return draft;
  }

  /** A sign-off as the page edits it: the first group, every group, how many approve, and who must. */
  function approvalDraft(approval) {
    if (!approval || approval.mode === 'none' || !(approval.authorities || []).length) return { group: null, groups: [], minimum: 1, required: [] };
    return { group: approval.authorities[0], groups: approval.authorities.slice(), minimum: approval.minimum || 1, required: (approval.requiredAuthorities || []).slice() };
  }
  /** Every group that signs a step off, the first one first. */
  function groupsOf(approval) {
    if (!approval || !approval.group) return [];
    var listed = (approval.groups || []).filter(function (id) { return id && id !== approval.group; });
    return [approval.group].concat(listed);
  }
  /** Two sign-offs are the same when they mean the same: groups, how many approve, who must. */
  function sameApproval(left, right) {
    return JSON.stringify(approvalChange({ approval: left || { group: null } })) === JSON.stringify(approvalChange({ approval: right || { group: null } }));
  }
  function approvalChange(step) {
    if (!step.approval.group) return 'none';
    var groups = groupsOf(step.approval);
    var change = { group: groups[0], minimum: step.approval.minimum || 1 };
    if (groups.length > 1) change.groups = groups;
    var required = (step.approval.required || []).filter(function (id) { return groups.indexOf(id) >= 0; });
    if (required.length) change.required = required;
    return change;
  }

  /**
   * The workflow a new step takes its own settings from when it is created: the one it was made in,
   * while that workflow still uses it, otherwise the first that does. Every other workflow using it
   * in the same draft sends its own settings where they differ.
   */
  function homeWorkflow(draft, phaseId) {
    function uses(id) { return Boolean(draft.workflows[id]) && draft.workflows[id].phases.indexOf(phaseId) >= 0; }
    var made = ((draft.phases[phaseId] || {}).usedBy || [])[0];
    if (made && uses(made)) return made;
    return Object.keys(draft.workflows).find(uses) || null;
  }

  /**
   * What a workflow that takes up a step has when it sets nothing itself: the step's own sign-off,
   * inputs (those among this workflow's steps) and drafting skill. A new step's own values are those
   * of the workflow it is created with, so a second workflow starts from them, as the engine does.
   */
  function inheritedSettings(draft, workflowId, phaseId) {
    var phase = draft.phases[phaseId] || {};
    var home = phase.isNew ? homeWorkflow(draft, phaseId) : null;
    var own = home && home !== workflowId && draft.steps[home] && draft.steps[home][phaseId] ? draft.steps[home][phaseId] : phase;
    var phases = draft.workflows[workflowId] ? draft.workflows[workflowId].phases : [];
    return { approval: clone(own.approval || { group: null, minimum: 1 }), inputs: (own.inputs || []).filter(function (input) { return phases.indexOf(input) >= 0; }),
      authoringSkill: own.authoringSkill || null, generatedByEngine: Boolean(phase.generatedByEngine), convergence: Boolean(phase.convergence), compiledSkill: Boolean(phase.compiledSkill),
      afterStep: clone(own.afterStep || []), template: null,
      optionalInputs: (own.optionalInputs || []).filter(function (input) { return phases.indexOf(input) >= 0; }) };
  }

  /**
   * Whether a workflow sets what a step produces itself: it loaded with an output other than the
   * step's own. Such a workflow keeps its output when the step's own output is edited.
   */
  function outputSetByWorkflow(settings, phase) {
    return Boolean(settings && settings.overridden && settings.output && phase && settings.output !== phase.baseOutput);
  }

  /** A step copy starts with the values shown in its workflow, retaining unsaved catalog edits. */
  function copiedPhaseDraft(model, draft, workflowId, phaseId, id) {
    var source = draft.phases[phaseId];
    var settings = draft.steps[workflowId][phaseId] || {};
    var output = outputSetByWorkflow(settings, source) ? settings.output : source.output;
    var baseline = (model.phases || []).find(function (phase) { return phase.id === phaseId; });
    var workflow = draft.workflows[workflowId];
    var originalWorkflow = (model.workflows || []).find(function (entry) { return entry.id === (workflow.copyOf || workflowId) && entry.phases.indexOf(phaseId) >= 0; });
    var copyFromWorkflow = originalWorkflow ? originalWorkflow.id : workflow.installFrom && source.fromBlueprint ? workflow.installFrom : null;
    // Whether the engine generates the step, or a compiled binding drafts it, is as this workflow
    // runs it; the copy is created from that, so it keeps the same fixed route.
    var copy = Object.assign(clone(source), { id: id, label: source.label + ' (' + workflow.label + ')', isNew: true, copyOf: phaseId, copyFromWorkflow: copyFromWorkflow, usedBy: [workflowId], output: output, baseOutput: output,
      views: baseline && same(source.views, baseline.views) && settings.views ? settings.views.slice() : (source.views || []).slice(),
      clarification: baseline && source.clarification === baseline.clarification ? settings.clarification || 'off' : source.clarification,
      authoringSkill: settings.authoringSkill || null,
      // The engine copies the step as its workflow runs it, actions included; that is the copy's start.
      afterStep: clone(settings.afterStep || source.afterStep || []), copiedAfterStep: clone(settings.afterStep || source.afterStep || []),
      generatedByEngine: settings.generatedByEngine !== undefined ? Boolean(settings.generatedByEngine) : Boolean(source.generatedByEngine),
      convergence: settings.convergence !== undefined ? Boolean(settings.convergence) : Boolean(source.convergence),
      compiledSkill: settings.compiledSkill !== undefined ? Boolean(settings.compiledSkill) : Boolean(source.compiledSkill) });
    delete copy.setAsideSkill;
    delete copy.templateChosen; delete copy.artifactSetChosen; delete copy.artifactFileChosen;
    // The engine writes a copy's file in its own folder: the set's primary member, or a file named after it.
    copy.artifactFile = source.artifactSet ? source.artifactFile : id + '.md';
    return copy;
  }

  /** The engine change set that turns the model into the draft. */
  function changeSetFrom(model, draft) {
    var base = initialDraft(model);
    var changes = [];
    // A changed packaged template becomes the repository's own copy; a repository template changes in place.
    Object.keys(draft.templates || {}).sort().forEach(function (relative) {
      var template = draft.templates[relative]; var before = base.templates[relative];
      if (!before) changes.push({ op: 'template.create', path: relative, content: template.content || '' });
      else if (template.content != null && template.content !== before.content) changes.push({ op: before.scope === 'packaged' ? 'template.create' : 'template.update', path: relative, content: template.content });
    });
    var setsNow = draft.artifactSets || {};
    Object.keys(setsNow).sort().forEach(function (id) {
      var set = setsNow[id]; var before = base.artifactSets[id];
      if (!before) changes.push({ op: 'artifactSet.create', id: id, primary: set.primary, members: clone(set.members) });
      else if (before.primary !== set.primary || !same(before.members, set.members)) changes.push({ op: 'artifactSet.update', id: id, primary: set.primary, members: clone(set.members) });
    });
    Object.keys(base.artifactSets).sort().forEach(function (id) { if (!setsNow[id]) changes.push({ op: 'artifactSet.remove', id: id }); });
    Object.keys(draft.groups).forEach(function (id) {
      var group = draft.groups[id]; var before = base.groups[id];
      if (!before) { changes.push({ op: 'group.create', id: id, label: group.label, members: group.members }); return; }
      var patch = { op: 'group.update', id: id };
      if (before.label !== group.label) patch.label = group.label;
      if (!same(before.members, group.members)) patch.members = group.members;
      if (Object.keys(patch).length > 2) changes.push(patch);
    });
    // Targets compare by meaning, so one rebuilt by the form with its fields in another order is unchanged.
    var targetsNow = draft.integrations || {};
    Object.keys(targetsNow).sort().forEach(function (id) {
      if (!base.integrations[id]) changes.push({ op: 'integration.target.create', id: id, target: clone(targetsNow[id]) });
      else if (canonical(base.integrations[id]) !== canonical(targetsNow[id])) changes.push({ op: 'integration.target.update', id: id, target: clone(targetsNow[id]) });
    });
    Object.keys(base.integrations).sort().forEach(function (id) { if (!targetsNow[id]) changes.push({ op: 'integration.target.remove', id: id }); });
    Object.keys(draft.agents).forEach(function (id) {
      var agent = draft.agents[id]; var before = base.agents[id];
      if (!before) { changes.push({ op: 'agent.create', id: id, label: agent.label, description: agent.description, role: agent.role || 'blank', tools: agent.tools, views: agent.views, instructions: agent.instructions }); return; }
      var patch = { op: 'agent.update', id: id };
      ['label', 'description', 'instructions'].forEach(function (key) { if (before[key] !== agent[key]) patch[key] = agent[key]; });
      ['tools', 'views'].forEach(function (key) { if (!same(before[key], agent[key])) patch[key] = agent[key]; });
      if (Object.keys(patch).length > 2) changes.push(patch);
    });
    var skillsNow = draft.skills || {};
    Object.keys(skillsNow).sort().forEach(function (id) {
      var skill = skillsNow[id]; var prior = base.skills[id];
      if (!prior) {
        var createdSkill = { op: 'skill.create', id: id, label: skill.label, description: skill.description, instructions: skill.instructions };
        if (skill.loading === 'on-demand') createdSkill.loading = skill.loading;
        changes.push(createdSkill); return;
      }
      var edit = { op: 'skill.update', id: id };
      ['label', 'description', 'instructions'].forEach(function (key) { if (prior[key] !== skill[key]) edit[key] = skill[key]; });
      if ((prior.loading || 'eager') !== (skill.loading || 'eager')) edit.loading = skill.loading || 'eager';
      if (Object.keys(edit).length > 2) changes.push(edit);
    });
    Object.keys(base.skills).sort().forEach(function (id) { if (!skillsNow[id]) changes.push({ op: 'skill.remove', id: id }); });
    Object.keys(draft.agents).sort().forEach(function (id) {
      var now = draft.agents[id].skills || []; var then = (base.agents[id] && base.agents[id].skills) || [];
      now.forEach(function (entry) {
        var prior = then.find(function (item) { return item.id === entry.id; });
        if (!prior || !same(prior.phases, entry.phases) || (prior.use || '') !== (entry.use || '')) changes.push({ op: 'skill.attach', skill: entry.id, agent: id, phases: entry.phases.slice(), use: entry.use || '' });
      });
      // A deleted skill is detached by its removal.
      then.forEach(function (entry) {
        if (skillsNow[entry.id] && !now.some(function (item) { return item.id === entry.id; })) changes.push({ op: 'skill.detach', skill: entry.id, agent: id });
      });
    });
    var installs = {};
    Object.keys(draft.workflows).sort().forEach(function (id) {
      var workflow = draft.workflows[id];
      var priorWorkflow = base.workflows[id] || (workflow.isNew && workflow.copyOf && base.workflows[workflow.copyOf]);
      var now = workflow.skills || []; var then = (priorWorkflow && priorWorkflow.skills) || [];
      now.forEach(function (entry) {
        var prior = then.find(function (item) { return item.id === entry.id; });
        if (!prior || !same(prior.phases, entry.phases) || (prior.use || '') !== (entry.use || '')) changes.push({ op: 'skill.attach', skill: entry.id, workflow: id, phases: entry.phases.slice(), use: entry.use || '' });
      });
      then.forEach(function (entry) {
        if (skillsNow[entry.id] && !now.some(function (item) { return item.id === entry.id; })) changes.push({ op: 'skill.detach', skill: entry.id, workflow: id });
      });
    });
    Object.keys(draft.workflows).forEach(function (id) { var from = draft.workflows[id].installFrom; if (from && !installs[from]) { installs[from] = true; changes.push({ op: 'workflow.install', id: from }); } });
    Object.keys(draft.phases).forEach(function (id) {
      var phase = draft.phases[id];
      if (phase.isNew) {
        var home = homeWorkflow(draft, id);
        var step = home && draft.steps[home] && draft.steps[home][id] ? draft.steps[home][id] : { approval: phase.approval, inputs: phase.inputs, authoringSkill: phase.authoringSkill, afterStep: phase.afterStep };
        var create = { op: 'phase.create', id: id, label: phase.label, output: phase.output, inputs: step.inputs, approval: approvalChange(step), views: phase.views, agent: phase.agent, clarification: phase.clarification || 'off', authoringSkill: step.authoringSkill || null };
        if (phase.copyOf) create.copyOf = phase.copyOf;
        if (phase.copyFromWorkflow) create.copyFromWorkflow = phase.copyFromWorkflow;
        if (phase.templateChosen && phase.template) create.template = phase.template;
        if (phase.artifactSetChosen && phase.artifactSet) create.artifactSet = phase.artifactSet;
        if (phase.artifactFileChosen && phase.artifactFile) create.artifactFile = phase.artifactFile;
        // A copy starts with its source's input entries as its workflow had them; only a changed
        // optional flag is sent, the way phase.update sends one.
        var copied = phase.copyOf ? ((phase.copyFromWorkflow && base.steps[phase.copyFromWorkflow] && base.steps[phase.copyFromWorkflow][phase.copyOf]) || base.phases[phase.copyOf] || {}).optionalInputs || [] : [];
        if (!same((step.optionalInputs || []).slice().sort(), copied.slice().sort())) create.inputs = inputEntriesFor(step.inputs || [], step.optionalInputs || [], copied);
        // A new step sends what its home workflow gives it; a copy starts with its source's actions,
        // so it says only when they were edited.
        var actions = step.afterStep || [];
        if (phase.copyOf ? !same(actions, phase.copiedAfterStep || []) : actions.length) create.afterStep = clone(actions);
        changes.push(create);
        return;
      }
      var baseline = base.phases[id] || (phase.fromBlueprint ? phase.blueprintBase : null);
      if (!baseline) return;
      var patch = { op: 'phase.update', id: id };
      if (baseline.label !== phase.label) patch.label = phase.label;
      if (baseline.output !== phase.output) patch.output = phase.output;
      if (!same(baseline.views, phase.views)) patch.views = phase.views;
      if ((baseline.clarification || 'off') !== phase.clarification) patch.clarification = phase.clarification;
      if ((baseline.template || null) !== (phase.template || null)) patch.template = phase.template || null;
      if ((baseline.artifactSet || null) !== (phase.artifactSet || null)) patch.artifactSet = phase.artifactSet || null;
      if (phase.artifactFile && (baseline.artifactFile || null) !== phase.artifactFile) patch.artifactFile = phase.artifactFile;
      if (Object.keys(patch).length > 2) changes.push(patch);
      if (baseline.agent !== phase.agent && phase.agent) changes.push({ op: 'phase.agent', phase: id, agent: phase.agent });
    });
    Object.keys(draft.workflows).forEach(function (id) {
      var workflow = draft.workflows[id]; var before = base.workflows[id];
      // A duplicate is created from its source, which must still exist as it was loaded.
      var copySource = workflow.isNew && workflow.copyOf && base.workflows[workflow.copyOf] && draft.workflows[workflow.copyOf] && !draft.workflows[workflow.copyOf].isNew ? workflow.copyOf : null;
      if (workflow.isNew) { var create = { op: 'workflow.create', id: id, label: workflow.label, description: workflow.description, phases: workflow.phases }; if (copySource) create.copyOf = copySource; changes.push(create); }
      else if (before) {
        var patch = { op: 'workflow.update', id: id };
        if (before.label !== workflow.label) patch.label = workflow.label;
        if (before.description !== workflow.description) patch.description = workflow.description;
        if (!same(before.phases, workflow.phases)) patch.phases = workflow.phases;
        if (!same(before.reworkLoops, workflow.reworkLoops)) patch.reworkLoops = workflow.reworkLoops;
        if (!same(before.decisions, workflow.decisions || [])) patch.decisions = workflow.decisions || [];
        if (!same(before.plannedClaims || null, workflow.plannedClaims || null)) patch.plannedClaims = workflow.plannedClaims ? clone(workflow.plannedClaims) : 'infer';
        if (Object.keys(patch).length > 2) changes.push(patch);
      } else if (workflow.installFrom) {
        var installed = { op: 'workflow.update', id: id };
        if (workflow.label !== workflow.blueprintLabel) installed.label = workflow.label;
        if (!same(workflow.phases, workflow.blueprintPhases)) installed.phases = workflow.phases;
        if (workflow.reworkLoops.length) installed.reworkLoops = workflow.reworkLoops;
        if ((workflow.decisions || []).length) installed.decisions = workflow.decisions;
        if (Object.keys(installed).length > 2) changes.push(installed);
      }
      if (workflow.isNew) {
        // A copy already has its source's rules; only rules changed since copying are sent.
        var sourceRules = copySource ? base.workflows[copySource] : { reworkLoops: [], decisions: [] };
        var follow = { op: 'workflow.update', id: id };
        if (!same(workflow.reworkLoops, sourceRules.reworkLoops || [])) follow.reworkLoops = workflow.reworkLoops;
        if (!same(workflow.decisions || [], sourceRules.decisions || [])) follow.decisions = workflow.decisions || [];
        if (Object.keys(follow).length > 2) changes.push(follow);
      }
      workflow.phases.forEach(function (phaseId) {
        var phase = draft.phases[phaseId];
        var step = draft.steps[id] && draft.steps[id][phaseId];
        if (!phase || !step) return;
        // What this workflow has if it sends nothing for the step, and so what it must change.
        var reference; var referenceSkill;
        if (phase.isNew) {
          // A new step is created with its home workflow's settings; another workflow using it in
          // the same draft sends where it differs, and the engine keeps that as this workflow's own.
          var home = homeWorkflow(draft, phaseId);
          if (!home || home === id || !draft.steps[home] || !draft.steps[home][phaseId]) return;
          reference = draft.steps[home][phaseId];
          referenceSkill = reference.authoringSkill || null;
        } else {
          reference = before && base.steps[id] && base.steps[id][phaseId] ? base.steps[id][phaseId]
            : copySource && base.steps[copySource] && base.steps[copySource][phaseId] ? base.steps[copySource][phaseId]
              : { approval: (base.phases[phaseId] || phase).approval, inputs: (base.phases[phaseId] || phase).inputs, afterStep: (base.phases[phaseId] || phase).afterStep };
          // A workflow that sets the skill itself keeps it; any other follows the step's own skill as
          // this draft leaves it, which an output change can send back to automatic. The engine
          // writes a change where the workflow owns it: an override on a shared or already
          // overridden step, the step itself otherwise.
          referenceSkill = reference.authoringSkillSetByWorkflow ? reference.authoringSkill || null : phase.authoringSkill || null;
        }
        var update = { op: 'phase.update', id: phaseId, workflow: id };
        if (!sameApproval(reference.approval, step.approval)) update.approval = approvalChange(step);
        if (!same(reference.inputs, step.inputs) || !same(reference.optionalInputs || [], step.optionalInputs || [])) {
          update.inputs = same(reference.optionalInputs || [], step.optionalInputs || []) ? step.inputs
            : inputEntriesFor(step.inputs, step.optionalInputs || [], reference.optionalInputs || []);
        }
        if ((reference.template || null) !== (step.template || null)) update.template = step.template || null;
        if ((step.authoringSkill || null) !== referenceSkill) update.authoringSkill = step.authoringSkill || null;
        if (!same(reference.afterStep || [], step.afterStep || [])) update.afterStep = clone(step.afterStep || []);
        if (Object.keys(update).length > 3) changes.push(update);
      });
    });
    var epicsNow = draft.epics; var epicsBefore = base.epics;
    if (epicsNow && epicsBefore) {
      Object.keys(epicsNow.steps).forEach(function (id) {
        var step = epicsNow.steps[id]; var before = epicsBefore.steps[id];
        if (!before) {
          changes.push({ op: 'epicStep.create', id: id, label: step.label, agents: step.agents.slice(), lanes: step.lanes.slice(), views: step.views.slice(), approval: epicApprovalChange(step.approval) });
          step.outputs.forEach(function (output) { changes.push(epicOutputChange(id, output)); });
          return;
        }
        var patch = { op: 'epicStep.update', id: id };
        if (before.label !== step.label) patch.label = step.label;
        ['agents', 'lanes', 'views'].forEach(function (key) { if (!same(before[key], step[key])) patch[key] = step[key].slice(); });
        if (!step.approval.chain && !same(before.approval, step.approval)) patch.approval = epicApprovalChange(step.approval);
        if (Object.keys(patch).length > 2) changes.push(patch);
        step.outputs.forEach(function (output) {
          var was = before.outputs.find(function (entry) { return entry.id === output.id; });
          if (!was || !same(epicOutputFields(was), epicOutputFields(output))) changes.push(epicOutputChange(id, output));
        });
        before.outputs.forEach(function (was) { if (!step.outputs.some(function (entry) { return entry.id === was.id; })) changes.push({ op: 'epicOutput.remove', step: id, id: was.id }); });
      });
      Object.keys(epicsNow.workflows).forEach(function (id) {
        var workflow = epicsNow.workflows[id]; var before = epicsBefore.workflows[id];
        if (!before) {
          var create = { op: 'epicWorkflow.create', id: id, label: workflow.label, description: workflow.description, phases: workflow.phases.slice() };
          if (workflow.copyOf && epicsBefore.workflows[workflow.copyOf]) create.copyOf = workflow.copyOf;
          changes.push(create); return;
        }
        var patch = { op: 'epicWorkflow.update', id: id };
        if (before.label !== workflow.label) patch.label = workflow.label;
        if (before.description !== workflow.description) patch.description = workflow.description;
        if (!same(before.phases, workflow.phases)) patch.phases = workflow.phases.slice();
        if (Object.keys(patch).length > 2) changes.push(patch);
        Object.keys(workflow.localSteps || {}).forEach(function (stepId) {
          if (workflow.phases.indexOf(stepId) < 0) return;
          var step = workflow.localSteps[stepId], was = before.localSteps && before.localSteps[stepId];
          if (!was) return;
          var update = { op: 'epicStep.update', id: stepId, workflow: id };
          if (step.label !== was.label) update.label = step.label;
          ['agents', 'lanes', 'views'].forEach(function (key) { if (!same(step[key], was[key])) update[key] = clone(step[key]); });
          if (!step.approval.chain && !same(step.approval, was.approval)) update.approval = epicApprovalChange(step.approval);
          if (Object.keys(update).length > 3) changes.push(update);
          step.outputs.forEach(function (output) {
            var original = was.outputs.find(function (entry) { return entry.id === output.id; });
            if (original && !same(epicOutputFields(output), epicOutputFields(original))) changes.push(Object.assign(epicOutputChange(stepId, output), { workflow: id }));
          });
        });
      });
    }
    // Imports and marketplace trust are explicit operations the person queued; the engine orders them.
    (draft.imports || []).forEach(function (change) { changes.push(clone(change)); });
    return { schema: 'sflow-studio-change-set@1', base: model.base, changes: changes };
  }

  function epicApprovalChange(approval) {
    if (!approval.on || !approval.groups.length) return 'none';
    var change = { group: approval.groups[0], minimum: approval.minimum || 1 };
    if (approval.groups.length > 1) change.groups = approval.groups.slice();
    return change;
  }
  function epicOutputFields(output) {
    return { label: output.label, kind: output.kind, path: output.path, template: output.template || null, required: output.required !== false, consumes: (output.consumes || []).slice() };
  }
  function epicOutputChange(stepId, output) {
    var fields = epicOutputFields(output);
    return { op: 'epicOutput.set', step: stepId, id: output.id, label: fields.label, kind: fields.kind, path: fields.path, template: fields.template || '', required: fields.required, consumes: fields.consumes };
  }

  /**
   * Input entries as the engine reads them: a bare step ID keeps what the entry has, and
   * { phase, optional } says whether the step can go without it where that differs from before.
   */
  function inputEntriesFor(inputs, optional, before) {
    return inputs.map(function (id) {
      var now = optional.indexOf(id) >= 0; var was = before.indexOf(id) >= 0;
      return now === was ? id : { phase: id, optional: now };
    });
  }

  /** Plain words for one change, shown before the engine checks it. */
  function describe(change, draft) {
    function phaseName(id) { return (draft.phases[id] || {}).label || id; }
    function epicWorkflowName(id) { return draft.epics && draft.epics.workflows[id] ? draft.epics.workflows[id].label : id; }
    function epicStepName(id) { return draft.epics && draft.epics.steps[id] ? draft.epics.steps[id].label : id; }
    function agentName(id) { return (draft.agents[id] || {}).label || id; }
    function skillOwner(change) { return change.workflow ? 'Workflow ' + ((draft.workflows[change.workflow] || {}).label || change.workflow) : agentName(change.agent); }
    // A deleted skill is no longer in the draft; the loaded configuration still names it.
    function skillName(id) { return ((draft.skills || {})[id] || ((state.model && state.model.skills) || []).find(function (skill) { return skill.id === id; }) || {}).label || id; }
    switch (change.op) {
      case 'workflow.create': return 'New workflow ' + change.label + (change.copyOf ? ', a copy of ' + ((draft.workflows[change.copyOf] || {}).label || change.copyOf) : '') + ': ' + change.phases.map(phaseName).join(' → ');
      case 'workflow.install': return 'Add the packaged ' + (((state.model && state.model.blueprints) || []).find(function (bp) { return bp.id === change.id; }) || { label: change.id }).label + ' workflow';
      case 'workflow.update': return (change.label || (draft.workflows[change.id] || {}).label || change.id) + ': ' + Object.keys(change).filter(function (key) { return ['op', 'id'].indexOf(key) < 0; }).map(function (key) { return { label: 'name', description: 'description', phases: 'steps', reworkLoops: 'send-back rules', decisions: 'decisions', plannedClaims: 'planned claims' }[key] || key; }).join(', ') + ' changed';
      case 'phase.create': return 'New step ' + change.label + ', drafted by ' + agentName(change.agent) + (change.authoringSkill ? ' with /' + change.authoringSkill : '') + (change.afterStep && change.afterStep.length ? ', sending ' + change.afterStep.length + (change.afterStep.length === 1 ? ' action' : ' actions') + ' after it' : '');
      case 'phase.update': return phaseName(change.id) + ': ' + Object.keys(change).filter(function (key) { return ['op', 'id', 'workflow'].indexOf(key) < 0; }).map(function (key) { return { label: 'name', output: 'output', views: 'knowledge', clarification: 'questions', approval: 'sign-off', inputs: 'what it reads', authoringSkill: 'drafting skill', afterStep: 'actions after it', template: 'template', artifactSet: 'artifact set', artifactFile: 'file it writes' }[key] || key; }).join(', ') + ' changed' + (change.workflow && (change.approval !== undefined || change.inputs !== undefined || change.authoringSkill !== undefined || change.afterStep !== undefined) ? ' in ' + ((draft.workflows[change.workflow] || {}).label || change.workflow) : '');
      case 'phase.agent': return phaseName(change.phase) + ' is now drafted by ' + agentName(change.agent);
      case 'epicWorkflow.create': return 'New Epic workflow ' + change.label + (change.copyOf ? ', a linked copy of ' + epicWorkflowName(change.copyOf) : '');
      case 'epicWorkflow.update': return 'Epic workflow ' + (change.label || epicWorkflowName(change.id)) + ': ' + Object.keys(change).filter(function (key) { return ['op', 'id'].indexOf(key) < 0; }).map(function (key) { return { label: 'name', description: 'description', phases: 'steps' }[key] || key; }).join(', ') + ' changed';
      case 'epicStep.create': return 'New Epic step ' + change.label;
      case 'epicStep.update': return 'Epic step ' + (change.label || epicStepName(change.id)) + ': ' + Object.keys(change).filter(function (key) { return ['op', 'id'].indexOf(key) < 0; }).map(function (key) { return { label: 'name', agents: 'agents', lanes: 'lanes', views: 'knowledge', approval: 'sign-off' }[key] || key; }).join(', ') + ' changed';
      case 'epicOutput.set': return epicStepName(change.step) + ': output ' + (change.label || change.id) + ' set';
      case 'epicOutput.remove': return epicStepName(change.step) + ': output ' + change.id + ' removed';
      case 'agent.create': return 'New agent ' + change.label;
      case 'agent.update': return 'Agent ' + agentName(change.id) + ' changed';
      case 'skill.create': return 'New skill ' + (change.label || change.id) + ' in the skill master';
      case 'skill.update': return 'Skill ' + skillName(change.id) + ': ' + Object.keys(change).filter(function (key) { return ['op', 'id'].indexOf(key) < 0; }).map(function (key) { return { label: 'name', description: 'description', instructions: 'instructions' }[key] || key; }).join(', ') + ' changed';
      case 'skill.remove': return 'Delete skill ' + skillName(change.id) + ' from the skill master';
      case 'skill.attach': return skillOwner(change) + ' uses skill ' + skillName(change.skill) + (change.phases && change.phases.length ? ' in ' + change.phases.map(phaseName).join(', ') : change.workflow ? ' in every workflow step' : ' in every step it drafts') + (change.use ? ': ' + change.use : '');
      case 'skill.detach': return skillOwner(change) + ' no longer uses skill ' + skillName(change.skill);
      case 'import.librarySkill': return (change.replace ? 'Update skill ' : 'Skill ') + change.id + ' in the skill master, from ' + change.source;
      case 'group.create': return 'New approval group ' + change.label;
      case 'group.update': return ((draft.groups[change.id] || {}).label || change.id) + ': ' + (change.members ? 'people' : 'name') + ' changed';
      case 'import.skill': return (change.replace ? 'Update skill ' : 'Skill ') + change.id + ' for ' + agentName(change.agent) + (change.phases && change.phases.length ? ' in ' + change.phases.map(phaseName).join(', ') : '') + ', from ' + change.source;
      case 'import.template': return (change.replace ? 'Update template ' : 'Template ') + (change.label || change.id) + ' from ' + change.source + (change.phases && change.phases.length ? ', used by ' + change.phases.map(phaseName).join(', ') : '');
      case 'import.agent': return (change.replace ? 'Update an agent' : 'Agent') + ' from ' + change.source + (change.withoutDefaults ? ', without taking over steps' : '');
      case 'import.generated': return agentName(change.agent) + ' fetches ' + change.target + ' for ' + phaseName(change.phase);
      case 'import.mcpServer': return (change.replace ? 'Update MCP server' : 'MCP server') + ' from ' + change.source + (change.agents && change.agents.length ? ' for ' + change.agents.map(agentName).join(', ') : ', for imports only');
      case 'import.remove': return 'Remove ' + change.key;
      case 'integration.target.create': return 'New target ' + change.id + ' (' + kindOf(change.target.kind).label + ')' + (change.target.url ? ': ' + change.target.url : change.target.repository ? ': ' + change.target.repository + ' → ' + change.target.branch : change.target.drive ? ': drive ' + change.target.drive : change.target.issue ? ': issue ' + change.target.issue : change.target.kind === 'jira' ? ': each Story issue' : '');
      case 'integration.target.update': return 'Target ' + change.id + ' changed';
      case 'integration.target.remove': return 'Remove target ' + change.id;
      case 'marketplace.add': return 'Trust marketplace ' + (change.label || change.id);
      case 'marketplace.remove': return 'Stop trusting marketplace ' + change.id;
      case 'template.create': return ((draft.templates[change.path] || {}).scope === 'packaged' ? 'Customize the packaged template ' : 'New template ') + change.path;
      case 'template.update': return 'Template ' + change.path + ' changed';
      case 'artifactSet.create': return 'New artifact set ' + change.id + ' (' + change.members.length + (change.members.length === 1 ? ' member)' : ' members)');
      case 'artifactSet.update': return 'Artifact set ' + change.id + ' changed';
      case 'artifactSet.remove': return 'Remove artifact set ' + change.id;
      default: return change.op;
    }
  }

  window.__workflowStudio = { initialDraft: initialDraft, changeSetFrom: changeSetFrom, copiedPhaseDraft: copiedPhaseDraft, describe: describe, kebab: kebab,
    worldModelSection: function () { return worldModelSection.apply(null, arguments); }, knowledgeReader: function () { return knowledgeReader.apply(null, arguments); },
    newStepWorldModelHint: function () { return newStepWorldModelHint.apply(null, arguments); },
    newDecision: function () { return newDecision.apply(null, arguments); }, convertDecision: function () { return convertDecision.apply(null, arguments); },
    decisionLines: function () { return decisionLines.apply(null, arguments); }, reachOf: function () { return reachOf.apply(null, arguments); },
    targetOptions: function () { return targetOptions.apply(null, arguments); }, pruneDecisions: function () { return pruneDecisions.apply(null, arguments); },
    relabelRules: function () { return relabelRules.apply(null, arguments); }, buildTest: function () { return buildTest.apply(null, arguments); },
    importKey: function () { return importKey.apply(null, arguments); }, linkId: function () { return linkId.apply(null, arguments); },
    canvasLayout: function () { return canvasLayout.apply(null, arguments); }, copyStep: function () { return copyStep.apply(null, arguments); },
    // The draft operations the inspector runs, against the model the host sent, and that state.
    state: function () { return state; },
    openWorkflowCanvas: function () { return openWorkflowCanvas.apply(null, arguments); },
    createWorkflowFromWizard: function () { return createWorkflowFromWizard.apply(null, arguments); },
    removeNewWorkflow: function () { return removeNewWorkflow.apply(null, arguments); }, orphanedSteps: function () { return orphanedSteps.apply(null, arguments); },
    confirmAction: function () { return confirmAction.apply(null, arguments); }, discardDraft: function () { return discardDraft.apply(null, arguments); },
    restorableDraft: function () { return restorableDraft.apply(null, arguments); },
    // Artifacts: templates, the section designer, artifact sets, and what a step chooses.
    templateFromSections: function () { return templateFromSections.apply(null, arguments); }, newSection: function () { return newSection.apply(null, arguments); },
    changeSectionKind: function () { return changeSectionKind.apply(null, arguments); }, storyTemplate: function () { return storyTemplate.apply(null, arguments); },
    templateKey: function () { return templateKey.apply(null, arguments); }, templateUsers: function () { return templateUsers.apply(null, arguments); },
    artifactsState: function () { return artifactsState(); }, openTemplateForm: function () { return openTemplateForm.apply(null, arguments); },
    saveTemplateForm: function () { return saveTemplateForm.apply(null, arguments); }, closeTemplateForm: function () { return closeTemplateForm.apply(null, arguments); },
    openSetForm: function () { return openSetForm.apply(null, arguments); }, setFormProblems: function () { return setFormProblems.apply(null, arguments); },
    keepSetForm: function () { return keepSetForm.apply(null, arguments); },
    chooseTemplate: function () { return chooseTemplate.apply(null, arguments); }, chooseArtifactSet: function () { return chooseArtifactSet.apply(null, arguments); },
    // Proposals waiting for review, workflow bundles, governed files.
    requestProposals: function () { return requestProposals.apply(null, arguments); }, reviewProposal: function () { return reviewProposal.apply(null, arguments); },
    importWorkflows: function () { return importWorkflows.apply(null, arguments); }, openFile: function () { return openFile.apply(null, arguments); },
    // Epic workflows.
    epicsDraftFrom: function () { return epicsDraftFrom.apply(null, arguments); }, withDraftDefaults: function () { return withDraftDefaults.apply(null, arguments); },
    // Sign-off groups.
    approvalDraft: function () { return approvalDraft.apply(null, arguments); }, approvalChange: function () { return approvalChange.apply(null, arguments); },
    groupsOf: function () { return groupsOf.apply(null, arguments); }, setApprovalGroups: function () { return setApprovalGroups.apply(null, arguments); },
    // Send-back rules.
    addSendBack: function () { return addSendBack.apply(null, arguments); }, retargetSendBack: function () { return retargetSendBack.apply(null, arguments); },
    setLoopBudget: function () { return setLoopBudget.apply(null, arguments); }, loopBudget: function () { return loopBudget.apply(null, arguments); },
    createStep: function () { return createStep.apply(null, arguments); }, addExistingStep: function () { return addExistingStep.apply(null, arguments); },
    copyStepForWorkflow: function () { return copyStepForWorkflow.apply(null, arguments); }, stepSettings: function () { return stepSettings.apply(null, arguments); },
    stepOutput: function () { return stepOutput.apply(null, arguments); }, setStepOutput: function () { return setStepOutput.apply(null, arguments); },
    skillPicker: function () { return skillPicker.apply(null, arguments); }, chooseAuthoringSkill: function () { return chooseAuthoringSkill.apply(null, arguments); },
    // Skills from the skill master: for one step, or for any agent.
    stepSkillEntries: function () { return stepSkillEntries.apply(null, arguments); }, attachToStep: function () { return attachToStep.apply(null, arguments); },
    detachFromStep: function () { return detachFromStep.apply(null, arguments); }, stepSkillForm: function () { return stepSkillForm.apply(null, arguments); },
    saveStepSkill: function () { return saveStepSkill.apply(null, arguments); }, attachmentHint: function () { return attachmentHint.apply(null, arguments); },
    skillsView: function () { return skillsView(); }, openSkillForm: function () { return openSkillForm.apply(null, arguments); },
    saveSkillForm: function () { return saveSkillForm.apply(null, arguments); }, openAttachForm: function () { return openAttachForm.apply(null, arguments); },
    saveAttach: function () { return saveAttach.apply(null, arguments); }, detachSkill: function () { return detachSkill.apply(null, arguments); },
    keepsSkillsInFile: function () { return keepsSkillsInFile.apply(null, arguments); }, addPreviewedImport: function () { return addPreviewedImport.apply(null, arguments); },
    library: function () { return library(); },
    authoringSkillControl: function () { return authoringSkillControl.apply(null, arguments); },
    addStepAction: function () { return addStepAction.apply(null, arguments); }, setActionTarget: function () { return setActionTarget.apply(null, arguments); },
    setActionTrigger: function () { return setActionTrigger.apply(null, arguments); }, actionLine: function () { return actionLine.apply(null, arguments); },
    setActionRequired: function () { return setActionRequired.apply(null, arguments); },
    targetUsers: function () { return targetUsers.apply(null, arguments); }, targetFromForm: function () { return targetFromForm.apply(null, arguments); },
    newTargetForm: function () { return newTargetForm.apply(null, arguments); }, editTargetForm: function () { return editTargetForm.apply(null, arguments); },
    saveTargetForm: function () { return saveTargetForm.apply(null, arguments); }, removeTarget: function () { return removeTarget.apply(null, arguments); },
    integrationsState: function () { return integrationsState(); }, canonical: canonical };

  // ---- Rendering helpers ---------------------------------------------------------------------

  function el(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      // The page's CSP admits only nonce'd styles, so a style attribute would be dropped; the CSSOM is allowed.
      else if (key === 'style') node.style.cssText = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'value') node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    for (var index = 2; index < arguments.length; index += 1) append(node, arguments[index]);
    return node;
  }
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (item) { append(node, item); }); return; }
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  function button(label, onClick, attrs) { return el('button', Object.assign({ type: 'button', onclick: onClick }, attrs || {}), label); }
  function select(id, options, value, onChange, attrs) {
    var children = []; var groupName = null; var groupNode = null;
    options.forEach(function (option) {
      var node = el('option', { value: option.value, selected: option.value === value, disabled: option.disabled, title: option.title }, option.label);
      if (!option.group) { groupName = null; children.push(node); return; }
      if (option.group !== groupName) { groupName = option.group; groupNode = el('optgroup', { label: groupName }); children.push(groupNode); }
      groupNode.appendChild(node);
    });
    return el('select', Object.assign({ id: id, 'data-key': id, onchange: function (event) { onChange(event.target.value); } }, attrs || {}), children);
  }
  function field(id, label, control, hint) {
    return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
  }
  function textInput(id, value, onChange, attrs) {
    return el('input', Object.assign({ type: 'text', id: id, 'data-key': id, value: value || '', onchange: function (event) { onChange(event.target.value); } }, attrs || {}));
  }

  function post(message) { vscodeApi.postMessage(message); }
  /** A yes/no question the host asks as a modal, because a webview cannot. onConfirm runs only on yes. */
  function confirmAction(text, detail, ok, onConfirm) {
    state.confirmSeq += 1;
    var id = 'confirm-' + state.confirmSeq;
    state.confirms[id] = onConfirm;
    post({ type: 'studio.confirm', id: id, text: text, detail: detail || '', ok: ok });
  }
  function setStatus(text) { state.status = text; var node = document.getElementById('studio-status'); if (node) node.textContent = text; }

  // ---- Draft operations ----------------------------------------------------------------------

  function workflowSteps(workflowId) { var workflow = state.draft.workflows[workflowId]; return workflow ? workflow.phases : []; }
  function settingsIn(draft, workflowId, phaseId) {
    var steps = draft.steps[workflowId] || (draft.steps[workflowId] = {});
    if (!steps[phaseId]) steps[phaseId] = inheritedSettings(draft, workflowId, phaseId);
    return steps[phaseId];
  }
  function stepSettings(workflowId, phaseId) { return settingsIn(state.draft, workflowId, phaseId); }
  /**
   * What a step produces in one workflow: the workflow's own output where it sets one, which an edit
   * to the step's own output does not change, and the step's own output otherwise.
   */
  function stepOutput(workflowId, phaseId) {
    var phase = state.draft.phases[phaseId] || { output: 'document' };
    var settings = state.draft.steps[workflowId] && state.draft.steps[workflowId][phaseId];
    return outputSetByWorkflow(settings, phase) ? settings.output : phase.output;
  }
  function changesNow() { return state.draft && state.model ? changeSetFrom(state.model, state.draft).changes : []; }
  function changed() { state.plan = null; state.planKey = null; if (/^Checked:/.test(state.status)) setStatus(''); scheduleDraftSave(); requestRender(); }
  // Unpublished changes are kept by the host while the panel is closed; typed-but-unsaved form
  // fields (a person being added, a group being renamed) are not changes and are not kept.
  var draftSaving = null;
  var UI_ONLY_KEYS = { adding: true, renaming: true };
  function scheduleDraftSave() {
    clearTimeout(draftSaving);
    draftSaving = setTimeout(function () {
      if (!state.draft || !state.model) return;
      if (!changesNow().length) { post({ type: 'studio.draftClear' }); return; }
      post({ type: 'studio.draftSave', draft: JSON.stringify(state.draft, function (key, value) { return UI_ONLY_KEYS[key] ? undefined : value; }) });
    }, 500);
  }
  /** A kept draft is offered back only if it has the shape this page reads. */
  function restorableDraft(text) {
    var draft;
    try { draft = JSON.parse(text); } catch (error) { return null; }
    var objects = ['workflows', 'steps', 'phases', 'agents', 'groups', 'integrations'];
    if (!draft || typeof draft !== 'object' || !Array.isArray(draft.order) || !Array.isArray(draft.imports || [])) return null;
    return objects.every(function (key) { return draft[key] && typeof draft[key] === 'object' && !Array.isArray(draft[key]); }) ? draft : null;
  }

  // A text field commits on blur, which happens on the mousedown of whatever is clicked next. Re-
  // rendering right then would replace the very button being clicked and swallow the click, so a
  // render requested while a pointer is down waits until that click has been handled.
  var pointerDown = false; var renderQueued = false;
  // Deferred a tick even without a pointer, so a Tab move finishes and focus is restored where it went.
  function requestRender() { if (pointerDown) { renderQueued = true; return; } setTimeout(render, 0); }
  function flushRender() { pointerDown = false; if (renderQueued) { renderQueued = false; render(); } }

  /** Put a step right after another one, or at the end. */
  function insertStep(workflowId, phaseId, afterId) {
    var phases = state.draft.workflows[workflowId].phases;
    var at = afterId ? phases.indexOf(afterId) + 1 : 0;
    if (at > 0) phases.splice(at, 0, phaseId); else phases.push(phaseId);
  }

  function addExistingStep(workflowId, phaseId, afterId) {
    var workflow = state.draft.workflows[workflowId];
    if (!workflow || workflow.phases.indexOf(phaseId) >= 0) return;
    insertStep(workflowId, phaseId, afterId);
    stepSettings(workflowId, phaseId);
    pruneInputs(workflowId);
    state.step = phaseId;
    changed();
  }

  /** What the World Model gives a step about to be created, said before it exists. */
  function newStepWorldModelHint(agent, label) {
    var views = newStepViews(agent);
    var knowledge = state.model.choices.knowledge || {};
    var start = !agent ? 'World Model: the step starts with the views its agent reads'
      : views.length ? 'World Model: starts with ' + views.join(', ') + ' (what this agent reads)' : 'World Model: this agent reads no views; tick some once the step exists';
    var reader = knowledge.prompt === 'off' ? '' : ', plus repository knowledge for the ' + knowledgeReader(kebab(label || '')) + ' reader';
    return start + reader + '. Change the views after creating it.';
  }
  /** The World Model views a new step starts with: those its agent reads that this repository offers. */
  function newStepViews(agent) {
    var catalog = state.model.choices.views || [];
    var agentViews = agent && state.draft.agents[agent] ? state.draft.agents[agent].views || [] : [];
    return agentViews.map(function (view) { return String(view).replace(/@[0-9]+$/, ''); })
      .filter(function (view, index, list) { return catalog.indexOf(view) >= 0 && list.indexOf(view) === index; });
  }
  function createStep(workflowId, label, output, agent, afterId) {
    var id = kebab(label);
    if (!id) { setStatus('Give the new step a name.'); return null; }
    if (state.draft.phases[id]) { setStatus('A step called ' + label + ' already exists; add it from the list instead.'); return null; }
    var firstGroup = Object.keys(state.draft.groups)[0] || null;
    var phases = workflowSteps(workflowId);
    var previous = afterId && phases.indexOf(afterId) >= 0 ? [afterId] : phases.slice(-1);
    state.draft.phases[id] = { id: id, label: label, output: output, views: newStepViews(agent), clarification: 'off', agent: agent, usedBy: [workflowId], isNew: true, fromBlueprint: null, approval: { group: firstGroup, minimum: 1 }, inputs: previous, afterStep: [], artifactFile: id + '.md' };
    insertStep(workflowId, id, afterId);
    state.draft.steps[workflowId][id] = { approval: { group: firstGroup, groups: firstGroup ? [firstGroup] : [], minimum: 1, required: [] }, inputs: previous, afterStep: [] };
    state.step = id;
    changed();
    return id;
  }

  /**
   * Give one workflow its own copy of a step it shares, in the step's place: its settings in this
   * workflow, the steps that read it, its send-back rules and decisions move to the copy. The page
   * keeps only step IDs; the engine carries each input's own settings over when it makes the copy.
   * Returns the copy's ID, or null when this workflow already has one.
   */
  function copyStep(model, draft, workflowId, phaseId) {
    var id = kebab(phaseId + '-' + workflowId);
    if (draft.phases[id]) return null;
    var settings = clone(settingsIn(draft, workflowId, phaseId));
    draft.phases[id] = copiedPhaseDraft(model, draft, workflowId, phaseId, id);
    var workflow = draft.workflows[workflowId];
    workflow.phases = workflow.phases.map(function (phase) { return phase === phaseId ? id : phase; });
    workflow.skills = (workflow.skills || []).map(function (entry) { return Object.assign({}, entry, { phases: entry.phases.map(function (phase) { return phase === phaseId ? id : phase; }) }); });
    draft.steps[workflowId][id] = settings;
    // The copy is a step of its own: what it produces and its drafting skill are its own values.
    draft.steps[workflowId][id].authoringSkillSetByWorkflow = false;
    draft.steps[workflowId][id].afterStepSetByWorkflow = false;
    draft.steps[workflowId][id].overridden = false;
    delete draft.steps[workflowId][id].setAsideSkill;
    draft.phases[id].authoringSkill = draft.steps[workflowId][id].authoringSkill || null;
    delete draft.steps[workflowId][phaseId];
    workflow.phases.forEach(function (other) { var settings = draft.steps[workflowId][other]; if (settings) settings.inputs = settings.inputs.map(function (input) { return input === phaseId ? id : input; }); });
    workflow.reworkLoops = workflow.reworkLoops.map(function (loop) {
      var copy = { from: loop.from === phaseId ? id : loop.from, to: loop.to === phaseId ? id : loop.to, maxAttempts: loop.maxAttempts };
      if (loop.resetOnPhase) copy.resetOnPhase = loop.resetOnPhase === phaseId ? id : loop.resetOnPhase;
      return copy;
    });
    renameDecisionSteps(workflow, phaseId, id);
    return id;
  }

  function copyStepForWorkflow(workflowId, phaseId) {
    var source = state.draft.phases[phaseId];
    var id = copyStep(state.model, state.draft, workflowId, phaseId);
    if (!id) { setStatus('A copy already exists: ' + state.draft.phases[kebab(phaseId + '-' + workflowId)].label + '.'); return; }
    state.step = id;
    setStatus('This workflow now uses its own copy of ' + source.label + '; choose its agent freely.');
    changed();
  }

  function moveStep(workflowId, phaseId, delta) {
    var phases = state.draft.workflows[workflowId].phases;
    var index = phases.indexOf(phaseId); var target = index + delta;
    if (index < 0 || target < 0 || target >= phases.length) return;
    phases.splice(index, 1); phases.splice(target, 0, phaseId);
    pruneInputs(workflowId);
    changed();
  }

  function removeStep(workflowId, phaseId) {
    var workflow = state.draft.workflows[workflowId];
    if (workflow.phases.length <= 1) { setStatus('A workflow needs at least one step.'); return; }
    workflow.phases = workflow.phases.filter(function (phase) { return phase !== phaseId; });
    workflow.skills = (workflow.skills || []).filter(function (entry) { return !entry.phases.length || entry.phases.some(function (id) { return id !== phaseId; }); })
      .map(function (entry) { return Object.assign({}, entry, { phases: entry.phases.filter(function (id) { return id !== phaseId; }) }); });
    workflow.reworkLoops = workflow.reworkLoops.filter(function (loop) { return loop.from !== phaseId && loop.to !== phaseId && loop.resetOnPhase !== phaseId; });
    var droppedDecisions = pruneDecisions(workflow, phaseId);
    if (droppedDecisions.length) setStatus('Removed the decision ' + droppedDecisions.join(', ') + ', which used that step.');
    if (state.draft.phases[phaseId] && state.draft.phases[phaseId].isNew && !Object.keys(state.draft.workflows).some(function (id) { return state.draft.workflows[id].phases.indexOf(phaseId) >= 0; })) delete state.draft.phases[phaseId];
    pruneInputs(workflowId);
    if (state.step === phaseId) state.step = workflow.phases[0];
    changed();
  }

  /** A step can only read steps that come before it in this workflow. */
  function pruneInputs(workflowId) {
    var phases = workflowSteps(workflowId);
    phases.forEach(function (phaseId, index) {
      var settings = state.draft.steps[workflowId][phaseId];
      if (settings) settings.inputs = settings.inputs.filter(function (input) { return phases.indexOf(input) >= 0 && phases.indexOf(input) < index; });
    });
    state.draft.workflows[workflowId].reworkLoops = state.draft.workflows[workflowId].reworkLoops.filter(function (loop) { return phases.indexOf(loop.to) >= 0 && phases.indexOf(loop.to) < phases.indexOf(loop.from); });
  }

  // ---- Views ---------------------------------------------------------------------------------

  function groupHint(group) {
    if (!group) return '';
    if (group.members.length) return group.members.length + (group.members.length === 1 ? ' person' : ' people');
    return { anyone: 'anyone with Git access', teams: 'GitHub teams', auto: 'empty: the first person to start a Story is added', blocked: 'nobody yet' }[group.status] || 'nobody yet';
  }
  function groupBlocked(groupId) { var group = state.draft.groups[groupId]; return Boolean(group && !group.members.length && group.status === 'blocked'); }
  function agentOptions(selected) {
    var options = Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); })
      .map(function (id) { var agent = state.draft.agents[id]; return { value: id, label: agent.label + (agent.isNew ? ' (new)' : '') }; });
    if (!selected) options.unshift({ value: '', label: 'Choose an agent…' });
    options.push({ value: '__new__', label: 'Create a new agent…' });
    return options;
  }

  /** Where a sub-view opened from the board goes back to: the same workflow, step and decision. */
  function boardReturn() { return { view: 'board', workflow: state.workflow, step: state.step, decision: state.decision }; }
  function backLink(main) {
    var back = state.returnTo;
    if (!back) return;
    var label = back.view === 'board' && state.draft.workflows[back.workflow]
      ? 'Back to ' + state.draft.workflows[back.workflow].label + ' · ' + stepLabel(back.step)
      : back.view === 'agents' ? 'Back to Agents' : 'Back';
    main.appendChild(el('div', { class: 'studio-row' }, button('← ' + label, function () {
      state.returnTo = null; state.view = back.view;
      if (back.view === 'board') { state.workflow = back.workflow; state.step = back.step; state.decision = back.decision || null; state.panel = null; }
      render();
    }, { class: 'secondary', 'data-key': 'back-link' })));
  }

  function renderNav(root) {
    var pending = changesNow().length;
    var blocked = Object.keys(state.draft.groups).filter(groupBlocked).length;
    // A target some step sends to, whose secret this machine does not have: its deliveries would wait.
    var secretsHere = integrationsState().secrets;
    var jiraHere = integrationsState().jira;
    var missingSecrets = targetIds().filter(function (id) {
      var target = state.draft.integrations[id];
      if (!targetUsers(id).length) return false;
      return target.kind === 'jira' ? jiraHere === 'missing' : targetSecrets(target).some(function (name) { return secretsHere[name] === 'missing'; });
    }).length;
    // On the canvas the navigation folds to icons, so the workflow gets the width.
    var compact = state.view === 'board';
    function item(view, label, iconName, count, attention) {
      var current = state.view === view || (view === 'home' && (state.view === 'board' || state.view === 'new' || state.view === 'epic'));
      var go = function () { state.returnTo = null; state.view = view; render(); };
      if (compact) {
        return el('button', { type: 'button', class: 'nav-icon', title: label + (attention ? ' (' + count + ')' : ''), 'aria-label': label + (attention ? ', ' + count : ''), 'aria-current': current ? 'page' : null, onclick: go },
          icon(iconName, 20), attention ? el('span', { class: 'count attention', text: String(count) }) : null);
      }
      return el('button', { type: 'button', class: 'nav-item', 'aria-current': current ? 'page' : null, onclick: go },
        el('span', { text: label }), count !== null ? el('span', { class: 'count' + (attention ? ' attention' : ''), text: String(count) }) : null);
    }
    root.appendChild(el('nav', { class: 'studio-nav', 'aria-label': 'Workflow Studio' },
      compact ? null : el('div', { class: 'brand', text: 'WORKFLOW STUDIO' }),
      item('home', 'Workflows', 'flow', Object.keys(state.draft.workflows).length, false),
      item('agents', 'Agents', 'agent', Object.keys(state.draft.agents).length, false),
      item('skills', 'Skill master', 'spark', Object.keys(state.draft.skills || {}).length || null, false),
      item('artifacts', 'Artifacts', 'doc', null, false),
      item('library', 'Library', 'book', (state.model.imports || []).length || null, false),
      item('people', 'People & approvals', 'people', blocked || null, blocked > 0),
      item('integrations', 'Integrations', 'plug', missingSecrets || targetIds().length || null, missingSecrets > 0),
      item('changes', 'Changes', 'list', pending, pending > 0),
      compact ? null : el('p', { class: 'note', text: 'Running Stories keep the workflow they started with. What you publish applies to new Stories after review.' })));
  }

  function rail(phases) {
    return el('div', { class: 'rail' }, phases.map(function (phaseId) {
      var phase = state.draft.phases[phaseId] || { label: phaseId };
      var agent = state.draft.agents[phase.agent] || null;
      return el('span', { class: 'stop' }, el('span', { class: 'avatar', title: agent ? agent.label : 'No agent', text: agent ? initials(agent.label) : '?' }), phase.label);
    }));
  }

  function workflowReadOnly(id) {
    var workflow = state.draft && state.draft.workflows[id];
    return Boolean(workflow && (workflow.readOnly || protectedObject('workflows', id)));
  }
  function openWorkflowCanvas(id) {
    if (typeof id === 'string' && id.indexOf('initiative:') === 0) return openEpicCanvas(id.slice(11));
    var workflow = typeof id === 'string' && state.draft && Object.prototype.hasOwnProperty.call(state.draft.workflows, id) && state.draft.workflows[id];
    if (!workflow) { setStatus('That workflow is no longer available. Reload the approved configuration.'); render(); return false; }
    state.workflow = id;
    state.step = workflow.phases[0] || null;
    state.decision = null;
    state.panel = workflowReadOnly(id) ? null : 'workflow';
    state.panelHidden = false;
    state.returnTo = null;
    state.view = 'board';
    render();
    return true;
  }
  function renderHome(main) {
    var workflows = state.draft.order.concat(Object.keys(state.draft.workflows).filter(function (id) { return state.draft.order.indexOf(id) < 0; }));
    var noAgent = Object.keys(state.draft.phases).filter(function (id) { return !state.draft.phases[id].agent && workflows.some(function (workflowId) { return workflowSteps(workflowId).indexOf(id) >= 0; }); });
    var blocked = Object.keys(state.draft.groups).filter(groupBlocked);
    var pending = changesNow().length;
    main.appendChild(el('header', { class: 'studio-card', style: 'border:0;background:transparent;padding:0' },
      el('h1', { text: 'Design how your team works' }),
      el('p', { class: 'studio-lede', text: 'A workflow is the list of steps a Story goes through. In each step an agent drafts the work and people sign it off. Arrange the steps, pick who does what from the lists, then publish once.' })));
    function check(kind, title, detail, action) {
      return el('div', { class: 'check-row' }, el('span', { class: 'mark ' + kind, 'aria-hidden': 'true', text: kind === 'ok' ? '✓' : kind === 'dim' ? '' : '!' }),
        el('div', null, el('div', { text: title, style: 'font-weight:600' }), el('div', { class: 'muted', text: detail })), action || el('span'));
    }
    main.appendChild(el('section', { class: 'studio-card', 'aria-label': 'Ready for new Stories' },
      el('div', { class: 'studio-row spread' }, el('h2', { text: 'Ready for new Stories?' })),
      check('ok', workflows.length + (workflows.length === 1 ? ' workflow' : ' workflows'), 'Any of them can start a Story once published.'),
      blocked.length ? check('bad', blocked.length + (blocked.length === 1 ? ' approval group can never approve' : ' approval groups can never approve'), 'Add people to ' + blocked.map(function (id) { return state.draft.groups[id].label; }).join(', ') + ', or steps they sign off can never finish.', button('Add people', function () { state.view = 'people'; render(); })) : check('ok', 'Every approval group can sign off', 'Empty groups enrol whoever starts a Story, unless your repository requires named people.'),
      noAgent.length ? check('bad', noAgent.length + ' step(s) have no agent', noAgent.map(function (id) { return state.draft.phases[id].label; }).join(', '), null) : check('ok', 'Every step has an agent', 'Each step has exactly one agent that drafts it.'),
      pending ? check('wait', pending + (pending === 1 ? ' change' : ' changes') + ' not published yet', 'Check and publish them together from Changes.', button('Review changes', function () { state.view = 'changes'; render(); }, { class: 'primary' })) : check('dim', 'No unpublished changes', 'Edits you make collect here until you publish them.')));
    main.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Your workflows' }), el('div', { class: 'studio-row' },
      button(state.busy === 'import' ? 'Importing…' : 'Import…', importWorkflows, { class: 'secondary', disabled: Boolean(state.busy), title: 'Add workflows from a bundle file, as one reviewed change' }),
      button('Export…', function () { state.exporting = state.exporting || {}; render(); }, { class: 'secondary' }),
      button('New workflow', function () { state.view = 'new'; state.wizard = { label: '', from: null }; render(); }, { class: 'primary' }))));
    if (state.exporting) main.appendChild(renderExport());
    workflows.forEach(function (id) {
      var workflow = state.draft.workflows[id];
      var readOnly = workflowReadOnly(id);
      var code = workflow.phases.some(function (phaseId) { return stepOutput(id, phaseId) === 'code'; });
      main.appendChild(el('article', { class: 'studio-card' },
        el('div', { class: 'studio-row spread' },
          el('div', { class: 'studio-row' }, el('strong', { text: workflow.label }), workflow.isNew || workflow.installFrom ? el('span', { class: 'pill new', text: 'NEW' }) : null),
          el('div', { class: 'studio-row' },
            button(readOnly ? 'View' : 'Edit', function () { openWorkflowCanvas(id); }, { class: 'secondary', 'data-key': 'workflow-open-' + id,
              'aria-label': (readOnly ? 'View seeded workflow ' : 'Edit workflow in canvas: ') + workflow.label }),
            button('Duplicate', function () { duplicateWorkflow('story:' + id); }, { class: 'secondary', disabled: workflow.isNew || Boolean(workflow.installFrom), 'aria-label': 'Duplicate ' + workflow.label }))),
        el('span', { class: 'muted', text: workflow.phases.length + ' steps' + (code ? ' · writes code' : '') }),
        rail(workflow.phases)));
    });
    renderEpicList(main);
  }

  // ---- Epic workflows ----------------------------------------------------------------------------
  //
  // An Epic workflow (portfolio.yml) is the list of steps an Epic goes through before its Stories
  // start. Each step drafts a set of outputs that people sign off together. Review packs, chains and
  // checklists stay in the file; everything else is edited here and published with the other changes.

  function epicStepLabel(id) { var step = state.draft.epics && state.draft.epics.steps[id]; return step ? step.label : id; }
  function epicStepFor(workflow, id) { return workflow.localSteps && workflow.localSteps[id] || state.draft.epics.steps[id]; }
  function openEpicCanvas(id) {
    var workflow = state.draft && state.draft.epics && Object.prototype.hasOwnProperty.call(state.draft.epics.workflows, id) && state.draft.epics.workflows[id];
    if (!workflow) { setStatus('That workflow is no longer available. Reload the approved configuration.'); render(); return false; }
    state.view = 'epic'; state.epic = id; state.epicStep = workflow.phases[0] || null;
    state.epicOutput = null; state.returnTo = null; render(); return true;
  }
  /** Epic nodes share the canvas layout and arrows; their inspector retains portfolio policy. */
  function renderEpicCanvas(workflow) {
    var layout = canvasLayout({ phases: workflow.phases }, {}, 0);
    var viewport = el('div', { class: 'canvas', role: 'region', tabindex: '0', 'aria-label': 'Workflow canvas: ' + workflow.label });
    viewport.style.cssText = 'height:' + Math.max(220, layout.height + 16) + 'px;overflow:auto;cursor:auto;touch-action:auto';
    var world = el('div', { class: 'canvas-world' });
    world.style.cssText = 'width:' + layout.width + 'px;height:' + layout.height + 'px';
    world.appendChild(renderEdges(layout));
    layout.nodes.forEach(function (node) {
      var step = epicStepFor(workflow, node.id);
      var card = el('button', { type: 'button', class: 'node tone-analysis' + (state.epicStep === node.id ? ' selected' : ''),
        'aria-label': 'Edit Epic step ' + (step ? step.label : node.id), 'aria-pressed': state.epicStep === node.id ? 'true' : 'false',
        onclick: function () { state.epicStep = node.id; state.epicOutput = null; render(); } },
        el('span', { class: 'lane-label', text: 'Step ' + (node.index + 1) }),
        el('strong', { text: step ? step.label : node.id }),
        el('span', { class: 'muted', text: step ? step.outputs.length + ' outputs' : 'Step unavailable' }));
      card.style.cssText = 'left:' + node.x + 'px;top:' + node.y + 'px;width:' + node.w + 'px;height:' + node.h + 'px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;padding:16px;gap:8px';
      world.appendChild(card);
    });
    var finish = el('div', { class: 'finish' }, icon('flag', 14), 'Finish');
    finish.style.cssText = 'left:' + layout.finish.x + 'px;top:' + layout.finish.y + 'px;width:' + FINISH_W + 'px;height:36px';
    world.appendChild(finish); viewport.appendChild(world); return viewport;
  }
  function renderEpicList(main) {
    var epics = state.draft.epics;
    if (!epics) return;
    main.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Epic workflows' }),
      button('New Epic workflow', function () { state.epicForm = { label: '', description: '', from: null, copy: false }; render(); }, { class: 'primary' })));
    if (state.epicForm) main.appendChild(renderEpicForm(state.epicForm));
    epics.order.concat(Object.keys(epics.workflows).filter(function (id) { return epics.order.indexOf(id) < 0; })).forEach(function (id) {
      var workflow = epics.workflows[id];
      main.appendChild(el('article', { class: 'studio-card', 'aria-label': 'Epic workflow ' + workflow.label },
        el('div', { class: 'studio-row spread' },
          el('div', { class: 'studio-row' }, el('strong', { text: workflow.label }), workflow.isNew ? el('span', { class: 'pill new', text: 'NEW' }) : null,
            el('span', { class: 'pill', text: workflow.lifecycleMode === 'planning-only' ? 'Plans Stories' : 'Full delivery' })),
          el('div', { class: 'studio-row' },
            button(protectedObject('epics', id) ? 'View' : 'Edit', function () { openEpicCanvas(id); }, { class: 'secondary',
              'aria-label': (protectedObject('epics', id) ? 'View seeded Epic workflow ' : 'Edit Epic workflow in canvas: ') + workflow.label }),
            button('Duplicate', function () { duplicateWorkflow('initiative:' + id); }, { class: 'secondary', disabled: workflow.isNew, 'aria-label': 'Duplicate ' + workflow.label }))),
        el('span', { class: 'muted', text: workflow.phases.length + (workflow.phases.length === 1 ? ' step' : ' steps') + (workflow.packs ? ' · ' + workflow.packs + ' review packs' : '') + (workflow.description ? ' · ' + workflow.description : '') }),
        el('div', { class: 'rail' }, workflow.phases.map(function (phaseId) { return el('span', { class: 'pill', text: epicStepLabel(phaseId) }); }))));
    });
  }
  function renderEpicForm(form) {
    var epics = state.draft.epics;
    var id = kebab(form.label);
    var card = el('section', { class: 'studio-card', 'aria-label': form.copy ? 'Duplicate an Epic workflow' : 'New Epic workflow' });
    card.appendChild(el('h2', { text: form.copy ? 'Duplicate ' + epics.workflows[form.from].label : 'New Epic workflow' }));
    card.appendChild(el('div', { class: 'grid-2' },
      field('epic-form-name', 'Name', textInput('epic-form-name', form.label, function (value) { form.label = value; render(); }, { placeholder: 'Vendor selection' }),
        id ? 'ID ' + id + (epics.workflows[id] ? ' is already used: choose another name' : '') : 'The ID is made from the name.'),
      field('epic-form-description', 'What is it for? (optional)', textInput('epic-form-description', form.description, function (value) { form.description = value; }))));
    if (!form.copy) {
      card.appendChild(el('p', { class: 'muted', text: 'Start a new workflow here. To customize an existing workflow, use Duplicate and review its dependency identities.' }));
    } else {
      card.appendChild(el('p', { class: 'muted', text: 'A linked copy shares its source\'s steps and review packs: changing a shared step changes both workflows.' }));
    }
    card.appendChild(el('div', { class: 'studio-row' },
      button(form.copy ? 'Create the copy' : 'Create Epic workflow', function () {
        if (!id || epics.workflows[id]) return;
        var source = form.from ? epics.workflows[form.from] : null;
        var phases = source ? source.phases.slice() : [];
        if (!phases.length) { var first = Object.keys(epics.steps)[0]; if (first) phases = [first]; }
        epics.workflows[id] = { id: id, label: form.label.trim(), description: (form.description || '').trim(), phases: phases, lifecycleMode: source ? source.lifecycleMode : 'full-delivery', packs: form.copy && source ? source.packs : 0, isNew: true, copyOf: form.copy ? form.from : null };
        epics.order.push(id);
        state.epicForm = null; state.view = 'epic'; state.epic = id; state.epicStep = phases[0] || null; changed();
      }, { class: 'primary', disabled: !id || Boolean(epics.workflows[id]) }),
      button('Cancel', function () { state.epicForm = null; render(); }, { class: 'secondary' })));
    return card;
  }

  function renderEpic(main) {
    var epics = state.draft.epics;
    var workflow = epics && epics.workflows[state.epic];
    if (!workflow) { state.view = 'home'; renderHome(main); return; }
    if (protectedObject('epics', workflow.id)) { renderSeededWorkflow(main, workflow, 'initiative'); return; }
    main.appendChild(el('div', { class: 'studio-row' }, button('← Workflows', function () { state.view = 'home'; state.epic = null; state.epicStep = null; state.epicOutput = null; render(); }, { class: 'secondary', 'data-key': 'epic-back' })));
    main.appendChild(el('header', null, el('h1', { text: workflow.label }),
      el('p', { class: 'studio-lede', text: 'An Epic goes through these steps before its Stories start. In each step an agent drafts its outputs and people sign them off together.' })));
    var details = el('section', { class: 'studio-card', 'aria-label': 'Epic workflow' });
    details.appendChild(el('div', { class: 'grid-2' },
      field('epic-name', 'Name', textInput('epic-name', workflow.label, function (value) { if (value.trim()) { workflow.label = value.trim(); changed(); } })),
      field('epic-description', 'What it is for', textInput('epic-description', workflow.description, function (value) { workflow.description = value.trim(); changed(); }))));
    details.appendChild(el('span', { class: 'hint', text: (workflow.lifecycleMode === 'planning-only' ? 'It plans Stories; delivery happens in them.' : 'It runs delivery to the end.') + (workflow.packs ? ' Its ' + workflow.packs + ' review packs stay in portfolio.yml.' : '') }));
    main.appendChild(details);

    var steps = el('section', { class: 'studio-card', 'aria-label': 'Steps' });
    steps.appendChild(el('h2', { text: 'Steps' }));
    steps.appendChild(renderEpicCanvas(workflow));
    workflow.phases.forEach(function (phaseId, index) {
      var step = epicStepFor(workflow, phaseId) || { label: phaseId, outputs: [], approval: { on: false, groups: [] } };
      var selected = state.epicStep === phaseId;
      steps.appendChild(el('div', { class: 'decision-box', 'aria-current': selected ? 'true' : null },
        el('div', { class: 'studio-row spread' },
          button((index + 1) + '. ' + step.label, function () { state.epicStep = phaseId; state.epicOutput = null; render(); }, { class: selected ? 'primary' : 'secondary', 'aria-label': 'Edit the step ' + step.label }),
          el('div', { class: 'studio-row' },
            button('Move up', function () { workflow.phases.splice(index - 1, 0, workflow.phases.splice(index, 1)[0]); changed(); }, { class: 'secondary', disabled: index === 0 }),
            button('Move down', function () { workflow.phases.splice(index + 1, 0, workflow.phases.splice(index, 1)[0]); changed(); }, { class: 'secondary', disabled: index === workflow.phases.length - 1 }),
            button('Remove', function () { workflow.phases.splice(index, 1); if (state.epicStep === phaseId) state.epicStep = workflow.phases[0] || null; changed(); }, { class: 'secondary', disabled: workflow.phases.length === 1, 'aria-label': 'Remove ' + step.label + ' from this workflow' }))),
        el('span', { class: 'muted', text: step.outputs.length + (step.outputs.length === 1 ? ' output' : ' outputs') + ' · ' + (step.approval.on ? 'signed off by ' + step.approval.groups.map(epicGroupLabel).join(', ') : 'no sign-off') })));
    });
    var others = Object.keys(epics.steps).filter(function (id) { return workflow.phases.indexOf(id) < 0; });
    var adding = state.epicAdding || (state.epicAdding = { existing: others[0] || '', label: '' });
    if (others.indexOf(adding.existing) < 0) adding.existing = others[0] || '';
    steps.appendChild(el('div', { class: 'grid-2' },
      el('div', { class: 'studio-row' },
        select('epic-add-existing', others.map(function (id) { return { value: id, label: epics.steps[id].label }; }), adding.existing, function (value) { adding.existing = value; }, { 'aria-label': 'A step from another Epic workflow', disabled: !others.length }),
        button('Add step', function () { if (!adding.existing) return; workflow.phases.push(adding.existing); state.epicStep = adding.existing; changed(); }, { class: 'secondary', disabled: !others.length })),
      el('div', { class: 'studio-row' },
        textInput('epic-add-new', adding.label, function (value) { adding.label = value; }, { placeholder: 'A new step', 'aria-label': 'Name of a new step' }),
        button('Create step', function () {
          var stepId = kebab(adding.label);
          if (!stepId || epics.steps[stepId]) { setStatus(stepId ? 'An Epic step called ' + stepId + ' already exists; add it instead.' : 'Name the new step.'); return; }
          epics.steps[stepId] = { id: stepId, label: adding.label.trim(), agents: [], lanes: [], views: [], approval: { on: false, groups: [], minimum: 1, chain: false }, outputs: [], checklist: 0, isNew: true };
          workflow.phases.push(stepId); adding.label = ''; state.epicStep = stepId; changed();
        }, { class: 'secondary' }))));
    main.appendChild(steps);
    if (state.epicStep && epicStepFor(workflow, state.epicStep) && workflow.phases.indexOf(state.epicStep) >= 0) main.appendChild(renderEpicStep(workflow, epicStepFor(workflow, state.epicStep)));
  }
  function epicGroupLabel(id) {
    var group = ((state.model.epics && state.model.epics.groups) || []).find(function (entry) { return entry.id === id; });
    return group ? group.label : id;
  }
  function toggled(list, value, on) { return on ? (list.indexOf(value) >= 0 ? list : list.concat([value])) : list.filter(function (entry) { return entry !== value; }); }
  function renderEpicStep(workflow, step) {
    var epics = state.draft.epics;
    var card = el('section', { class: 'studio-card', 'aria-label': 'Epic step ' + step.label });
    card.appendChild(el('h2', { text: step.label }));
    var sharedWith = Object.keys(epics.workflows).filter(function (id) { return id !== workflow.id && epics.workflows[id].phases.indexOf(step.id) >= 0; });
    if (step.local) card.appendChild(el('div', { class: 'callout', text: 'Workflow-local settings: changes here affect only this copy. Canonical step and output identities remain fixed.' }));
    else if (protectedObject('epicPhases', step.id)) { card.appendChild(el('p', { text: 'This shared seeded step is read-only. Duplicate its workflow to customize a copy.' })); return card; }
    else if (sharedWith.length) card.appendChild(el('div', { class: 'callout wait', text: 'Also used by ' + sharedWith.map(function (id) { return epics.workflows[id].label; }).join(', ') + ': changes to this step apply there too.' }));
    card.appendChild(field('epic-step-name', 'Name', textInput('epic-step-name', step.label, function (value) { if (value.trim()) { step.label = value.trim(); changed(); } })));
    card.appendChild(el('span', { class: 'lane-label', text: 'AGENTS' }));
    card.appendChild(el('div', { class: 'checks' }, Object.keys(state.draft.agents).map(function (id) {
      return el('label', null, el('input', { type: 'checkbox', 'data-key': 'epic-agent-' + id, checked: step.agents.indexOf(id) >= 0, onchange: function (event) { step.agents = toggled(step.agents, id, event.target.checked); changed(); } }), ' ' + state.draft.agents[id].label);
    })));
    var lanes = ((state.model.epics && state.model.epics.lanes) || []).concat(step.lanes).filter(function (lane, index, all) { return all.indexOf(lane) === index; });
    card.appendChild(el('span', { class: 'lane-label', text: 'LANES' }));
    card.appendChild(el('div', { class: 'checks' }, lanes.map(function (lane) {
      return el('label', null, el('input', { type: 'checkbox', 'data-key': 'epic-lane-' + lane, checked: step.lanes.indexOf(lane) >= 0, onchange: function (event) { step.lanes = toggled(step.lanes, lane, event.target.checked); changed(); } }), ' ' + lane);
    })));
    card.appendChild(el('div', { class: 'studio-row' }, textInput('epic-new-lane', '', function (value) {
      var lane = kebab(value); if (!lane) return; step.lanes = toggled(step.lanes, lane, true); changed();
    }, { placeholder: 'Add a lane, like engineering', 'aria-label': 'Add a lane' })));
    var views = state.model.choices.views || [];
    if (views.length) {
      card.appendChild(el('span', { class: 'lane-label', text: 'KNOWLEDGE VIEWS' }));
      card.appendChild(el('div', { class: 'checks' }, views.map(function (view) {
        return el('label', null, el('input', { type: 'checkbox', 'data-key': 'epic-view-' + view, checked: step.views.indexOf(view) >= 0, onchange: function (event) { step.views = toggled(step.views, view, event.target.checked); changed(); } }), ' ' + view);
      })));
    }
    card.appendChild(renderEpicSignoff(step));
    card.appendChild(renderEpicOutputs(workflow, step));
    if (step.checklist) card.appendChild(el('span', { class: 'hint', text: 'Its ' + step.checklist + ' checklist items stay in portfolio.yml.' }));
    return card;
  }
  function renderEpicSignoff(step) {
    var approval = step.approval;
    var groups = (state.model.epics && state.model.epics.groups) || [];
    var box = el('div', { class: 'decision-box', 'aria-label': 'Sign-off' }, el('div', { class: 'studio-row spread' }, el('strong', { text: 'Sign-off' }),
      approval.chain ? null : switchControl('epic-signoff', 'People sign off this step', approval.on, function (on) {
        approval.on = on; if (on && !approval.groups.length && groups[0]) approval.groups = [groups[0].id]; changed();
      })));
    if (approval.chain) { box.appendChild(el('div', { class: 'callout', text: 'Signed off through a review chain; change it in portfolio.yml.' })); return box; }
    if (!approval.on) { box.appendChild(el('span', { class: 'hint', text: 'No sign-off: the step completes when its outputs and checks are in place.' })); return box; }
    box.appendChild(el('div', { class: 'checks' }, groups.map(function (group) {
      var chosen = approval.groups.indexOf(group.id) >= 0;
      return el('label', null, el('input', { type: 'checkbox', 'data-key': 'epic-group-' + group.id, checked: chosen, disabled: chosen && approval.groups.length === 1, onchange: function (event) { approval.groups = toggled(approval.groups, group.id, event.target.checked); changed(); } }), ' ' + group.label);
    })));
    box.appendChild(field('epic-minimum', 'Approvals needed', el('input', { type: 'text', inputmode: 'numeric', id: 'epic-minimum', 'data-key': 'epic-minimum', value: String(approval.minimum || 1),
      onchange: function (event) {
        var count = /^\s*\d+\s*$/.test(event.target.value) ? Number(event.target.value) : NaN;
        if (!Number.isInteger(count) || count < 1 || count > 20) { setStatus('Approvals needed is a whole number from 1 to 20.'); render(); return; }
        approval.minimum = count; changed();
      } }), '1 to 20, from all the groups together'));
    return box;
  }
  function renderEpicOutputs(workflow, step) {
    var epics = state.draft.epics;
    var box = el('div', { class: 'decision-box', 'aria-label': 'Outputs' }, el('strong', { text: 'Outputs' }));
    if (!step.outputs.length) box.appendChild(el('span', { class: 'hint', text: 'No outputs yet. An output is a document the step drafts, from a template, into the Epic\'s folder.' }));
    step.outputs.forEach(function (output) {
      box.appendChild(el('div', { class: 'studio-row spread' },
        el('div', null, el('strong', { text: output.label }), el('span', { class: 'muted', text: '  ' + output.path + ' · ' + output.kind + (output.required === false ? ' · optional' : '') + (output.template ? ' · ' + output.template : output.generator ? ' · generated' : '') + ((output.consumes || []).length ? ' · reads ' + output.consumes.join(', ') : '') })),
        el('div', { class: 'studio-row' },
          button('Edit', function () { state.epicOutput = { step: step.id, id: output.id, label: output.label, kind: output.kind, path: output.path, template: output.template || '', required: output.required !== false, consumes: (output.consumes || []).slice(), isNew: false }; render(); }, { class: 'secondary', 'aria-label': 'Edit ' + output.label }),
          button('Remove', function () {
            var reference = step.id + '/' + output.id;
            var readers = Object.keys(epics.steps).filter(function (id) { return epics.steps[id].outputs.some(function (entry) { return (entry.consumes || []).indexOf(reference) >= 0; }); });
            if (readers.length) { setStatus(reference + ' is read by ' + readers.map(epicStepLabel).join(', ') + '; take it off them first.'); return; }
            step.outputs = step.outputs.filter(function (entry) { return entry.id !== output.id; }); changed();
          }, { class: 'secondary', disabled: step.local, 'aria-label': 'Remove ' + output.label }))));
    });
    var form = state.epicOutput && state.epicOutput.step === step.id ? state.epicOutput : null;
    if (!form) {
      box.appendChild(el('div', { class: 'studio-row' }, button('Add output', function () { state.epicOutput = { step: step.id, id: '', label: '', kind: 'markdown', path: '', template: '', required: true, consumes: [], isNew: true }; render(); }, { class: 'secondary', disabled: step.local })));
      return box;
    }
    var earlier = workflow.phases.slice(0, workflow.phases.indexOf(step.id)).reduce(function (all, phaseId) {
      return all.concat(((epics.steps[phaseId] || { outputs: [] }).outputs).map(function (entry) { return { value: phaseId + '/' + entry.id, label: epicStepLabel(phaseId) + ' / ' + entry.label }; }));
    }, []);
    var templates = Object.keys(state.draft.templates).sort();
    var outputId = form.isNew ? kebab(form.label) : form.id;
    box.appendChild(el('div', { class: 'grid-2' },
      field('epic-output-label', 'Name', textInput('epic-output-label', form.label, function (value) { form.label = value; render(); }, { placeholder: 'Vendor brief' }), form.isNew ? (outputId ? 'ID ' + outputId : 'The ID is made from the name.') : 'ID ' + form.id),
      field('epic-output-kind', 'Kind', select('epic-output-kind', ((state.model.epics && state.model.epics.outputKinds) || ['markdown', 'yaml']).map(function (kind) { return { value: kind, label: kind }; }), form.kind, function (value) { form.kind = value; render(); }))));
    box.appendChild(el('div', { class: 'grid-2' },
      field('epic-output-path', 'File', textInput('epic-output-path', form.path, function (value) { form.path = value.trim(); }, { placeholder: (outputId || 'output') + (form.kind === 'yaml' ? '.yml' : '.md') }), 'Inside the Epic\'s folder.'),
      field('epic-output-template', 'Template', select('epic-output-template', [{ value: '', label: 'None' }].concat(templates.map(function (relative) { return { value: relative, label: relative }; })), form.template, function (value) { form.template = value; }))));
    box.appendChild(el('label', null, el('input', { type: 'checkbox', 'data-key': 'epic-output-required', checked: form.required, onchange: function (event) { form.required = event.target.checked; } }), ' required: the step is not complete without it'));
    if (earlier.length) {
      box.appendChild(el('span', { class: 'lane-label', text: 'READS' }));
      box.appendChild(el('div', { class: 'checks' }, earlier.map(function (entry) {
        return el('label', null, el('input', { type: 'checkbox', 'data-key': 'epic-output-reads-' + entry.value, checked: form.consumes.indexOf(entry.value) >= 0, onchange: function (event) { form.consumes = toggled(form.consumes, entry.value, event.target.checked); } }), ' ' + entry.label);
      })));
    }
    box.appendChild(el('div', { class: 'studio-row' },
      button('Keep output', function () {
        if (!outputId) { setStatus('Name the output.'); return; }
        if (form.isNew && step.outputs.some(function (entry) { return entry.id === outputId; })) { setStatus(step.label + ' already has an output ' + outputId + '.'); return; }
        var kept = { id: outputId, label: form.label.trim() || outputId, kind: form.kind, path: form.path || (outputId + (form.kind === 'yaml' ? '.yml' : '.md')), template: form.template || null, required: form.required, consumes: form.consumes.slice() };
        var index = step.outputs.findIndex(function (entry) { return entry.id === outputId; });
        if (index >= 0) step.outputs[index] = Object.assign({}, step.outputs[index], kept); else step.outputs.push(Object.assign({ generator: null, ownApproval: false }, kept));
        state.epicOutput = null; changed();
      }, { class: 'primary' }),
      button('Cancel', function () { state.epicOutput = null; render(); }, { class: 'secondary' })));
    return box;
  }

  function renderWizard(main) {
    var wizard = state.wizard;
    var editing = wizard.editing && state.draft.workflows[wizard.editing] ? wizard.editing : null;
    var choices = [{ key: 'blank', label: 'Blank', description: 'Start with one step and add what you need. To customize an existing workflow, use Duplicate from the workflow list.', phases: [Object.keys(state.draft.phases).indexOf('intake') >= 0 ? 'intake' : Object.keys(state.draft.phases)[0]] }];
    if (!wizard.from) wizard.from = 'blank';
    if (editing && !choices.some(function (choice) { return choice.key === wizard.from; })) wizard.from = 'blank';
    var id = editing || kebab(wizard.label);
    main.appendChild(el('header', null, el('h1', { text: editing ? 'Workflow details' : 'New workflow' }), el('p', { class: 'studio-lede', text: editing
      ? 'It is not published yet, so you can still rename it, or start again from another point. Its ID stays ' + editing + '.'
      : 'Create your own workflow. Add, remove and reorder steps next; existing workflows are duplicated separately.' })));
    main.appendChild(el('div', { class: 'grid-2', style: 'max-width:820px' },
      field('wizard-name', 'Workflow name', textInput('wizard-name', wizard.label, function (value) { wizard.label = value; requestRender(); }, { placeholder: 'Vendor assessment' }),
        editing ? 'ID ' + editing + ' (kept)' : id ? 'ID ' + id + (state.draft.workflows[id] ? ' is already used: choose another name' : '') : 'The ID is made from the name.'),
      field('wizard-description', 'What is it for? (optional)', textInput('wizard-description', wizard.description, function (value) { wizard.description = value; }))));
    main.appendChild(el('div', { class: 'blueprints', role: 'group', 'aria-label': 'Start from' }, choices.map(function (choice) {
      return el('button', { type: 'button', class: 'blueprint', 'aria-pressed': wizard.from === choice.key ? 'true' : 'false', onclick: function () { wizard.from = choice.key; if (!wizard.label && choice.blueprint) wizard.label = choice.label; render(); } },
        el('strong', { text: choice.label }), el('span', { class: 'muted', text: choice.description }),
        el('span', { class: 'rail' }, choice.phases.slice(0, 7).map(function (phaseId) { return el('span', { class: 'pill', text: ((state.draft.phases[phaseId] || (state.model.blueprintPhases || {})[phaseId] || { label: phaseId }).label) }); })));
    })));
    if (editing) {
      var restart = wizard.from !== wizard.startedFrom;
      var picked = choices.find(function (choice) { return choice.key === wizard.from; });
      main.appendChild(el('div', { class: 'studio-row' },
        button(restart ? 'Start again from ' + picked.label : 'Save details', function () {
          var workflow = state.draft.workflows[editing];
          var label = wizard.label.trim();
          if (!restart) {
            workflow.label = label; workflow.description = (wizard.description || '').trim();
            state.view = 'board'; changed(); return;
          }
          confirmAction('Replace the steps of ' + workflow.label + '?',
            'The steps you arranged are replaced by those of ' + picked.label + '. Nothing is published yet, so nothing else changes.',
            'Replace steps', function () { removeNewWorkflow(editing, { keepView: true }); createWorkflowFromWizard(picked, editing); });
        }, { class: 'primary', disabled: !wizard.label.trim() }),
        button('Back to the board', function () { state.view = 'board'; render(); }, { class: 'secondary' })));
      return;
    }
    var blocked = !id || Boolean(state.draft.workflows[id]);
    main.appendChild(el('div', { class: 'studio-row' },
      button('Shape the steps', function () { createWorkflowFromWizard(choices.find(function (choice) { return choice.key === wizard.from; }), id); }, { class: 'primary', disabled: blocked }),
      button('Cancel', function () { state.wizard = null; state.view = 'home'; render(); }, { class: 'secondary' })));
  }

  /** The details of a new, unpublished workflow, in the screen that made it. */
  function openWorkflowDetails(workflowId) {
    var workflow = state.draft.workflows[workflowId];
    var startedFrom = workflow.startedFrom || (workflow.installFrom ? 'blueprint:' + workflow.installFrom : workflow.copyOf ? 'workflow:' + workflow.copyOf : 'blank');
    state.wizard = { label: workflow.label, description: workflow.description || '', from: startedFrom, startedFrom: startedFrom, editing: workflowId };
    state.view = 'new'; render();
  }

  /** Steps the draft made for a new workflow that no other workflow uses: they leave with it. */
  function orphanedSteps(workflow) {
    return workflow.phases.filter(function (phaseId) {
      var phase = state.draft.phases[phaseId];
      if (!phase || !(phase.isNew || phase.fromBlueprint)) return false;
      return !Object.keys(state.draft.workflows).some(function (other) { return other !== workflow.id && state.draft.workflows[other].phases.indexOf(phaseId) >= 0; });
    });
  }

  function askRemoveNewWorkflow(workflowId) {
    var workflow = state.draft.workflows[workflowId];
    var steps = orphanedSteps(workflow).map(stepLabel);
    confirmAction('Remove the new workflow ' + workflow.label + '?',
      'It has not been published, so nothing else changes.' + (steps.length ? ' These steps go with it, because no other workflow uses them: ' + steps.join(', ') + '.' : ''),
      'Remove workflow', function () { removeNewWorkflow(workflowId); setStatus('Removed the new workflow ' + workflow.label + '.'); });
  }

  /** Take a new workflow out of the draft, with the steps only it used. Published workflows never come here. */
  function removeNewWorkflow(workflowId, options) {
    var workflow = state.draft.workflows[workflowId];
    if (!workflow || !(workflow.isNew || workflow.installFrom)) return;
    var orphans = orphanedSteps(workflow);
    delete state.draft.workflows[workflowId];
    delete state.draft.steps[workflowId];
    state.draft.order = state.draft.order.filter(function (entry) { return entry !== workflowId; });
    orphans.forEach(function (phaseId) { delete state.draft.phases[phaseId]; });
    if (state.collapsed) delete state.collapsed[workflowId];
    if (state.canvas) delete state.canvas[workflowId];
    if (!options || !options.keepView) { state.workflow = null; state.step = null; state.decision = null; state.panel = null; state.wizard = null; state.view = 'home'; }
    changed();
  }

  function createWorkflowFromWizard(choice, id) {
    var label = state.wizard.label.trim();
    var workflow = { id: id, label: label, description: (state.wizard.description || '').trim(), phases: choice.phases.slice(), reworkLoops: [], decisions: [], skills: [], isNew: true, installFrom: null, startedFrom: choice.key };
    if (choice.blueprint) {
      workflow.installFrom = choice.blueprint.id;
      choice.blueprint.phases.forEach(function (phaseId) {
        if (state.draft.phases[phaseId]) return;
        var packaged = (state.model.blueprintPhases || {})[phaseId] || { label: phaseId, output: 'document', agent: null };
        state.draft.phases[phaseId] = { id: phaseId, label: packaged.label, output: packaged.output, views: [], clarification: 'off', agent: packaged.agent, usedBy: [], isNew: false, fromBlueprint: choice.blueprint.id, blueprintBase: { label: packaged.label, output: packaged.output, views: [], clarification: 'off', agent: packaged.agent, approval: packaged.approval, inputs: [] }, approval: packaged.approval, inputs: [] };
      });
      if (id === choice.blueprint.id) { workflow.isNew = false; workflow.blueprintLabel = choice.blueprint.label; workflow.blueprintPhases = choice.blueprint.phases.slice(); }
    } else if (choice.key.indexOf('workflow:') === 0) {
      workflow.copyOf = choice.key.slice(9);
      workflow.reworkLoops = clone(state.draft.workflows[workflow.copyOf].reworkLoops);
      workflow.decisions = clone(state.draft.workflows[workflow.copyOf].decisions || []);
      workflow.skills = clone(state.draft.workflows[workflow.copyOf].skills || []);
    }
    state.draft.workflows[id] = workflow;
    state.draft.steps[id] = {};
    var sourceSteps = choice.key.indexOf('workflow:') === 0 ? state.draft.steps[choice.key.slice(9)] : null;
    workflow.phases.forEach(function (phaseId) { state.draft.steps[id][phaseId] = sourceSteps && sourceSteps[phaseId] ? clone(sourceSteps[phaseId]) : stepSettings(id, phaseId); });
    state.workflow = id; state.step = workflow.phases[0]; state.view = 'board';
    changed();
  }

  // ---- Decisions -----------------------------------------------------------------------------
  //
  // A decision is edited in the shape it is written in workflow.yml, so the change set carries it
  // as authored and the engine validates the whole workflow: the same rules apply here and in YAML.

  var DECISION_KINDS = [
    { value: 'branch', label: 'If / else: rules choose the next step' },
    { value: 'loop', label: 'Loop until a goal' },
    { value: 'ask', label: 'Ask a person' }
  ];

  function decisionAfterStep(workflow, phaseId) {
    return (workflow.decisions || []).find(function (decision) { return decision.after === phaseId; }) || null;
  }
  function decisionById(workflow, id) {
    return (workflow.decisions || []).find(function (decision) { return decision.id === id; }) || null;
  }
  function stepLabel(id) {
    if (id === 'end') return 'Finish the Story';
    if (id === 'next') return 'Next step';
    return ((state.draft && state.draft.phases[id]) || { label: id }).label;
  }
  function uniqueId(base, taken) {
    var root = base || 'route'; var id = root; var count = 2;
    while (taken.indexOf(id) >= 0) { id = root + '-' + count; count += 1; }
    return id;
  }
  /** A value name the engine accepts: starts with a letter, then letters, digits and hyphens. */
  function inputName(label, taken) {
    var base = kebab(label) || 'value';
    if (!/^[a-z]/.test(base)) base = 'v-' + base;
    return uniqueId(base.slice(0, 40), taken);
  }

  /** Where a route leads from the step before the decision. */
  function reachOf(workflow, after, to) {
    var phases = workflow.phases; var from = phases.indexOf(after);
    if (to === 'next') return { kind: from + 1 < phases.length ? 'next' : 'end', target: phases[from + 1] || null, skips: [] };
    if (to === 'end') return { kind: 'end', target: null, skips: phases.slice(from + 1) };
    var at = phases.indexOf(to);
    if (at < 0) return { kind: 'missing', target: to, skips: [] };
    if (at <= from) return { kind: 'back', target: to, skips: [] };
    return { kind: at === from + 1 ? 'next' : 'forward', target: to, skips: phases.slice(from + 1, at) };
  }
  function targetText(workflow, after, to) {
    var reach = reachOf(workflow, after, to);
    if (reach.kind === 'end') return reach.skips.length ? 'Finish (skips ' + reach.skips.map(stepLabel).join(', ') + ')' : 'Finish';
    if (reach.kind === 'back') return '↩ ' + stepLabel(reach.target);
    if (reach.kind === 'missing') return stepLabel(reach.target) + ' (not in this workflow)';
    return stepLabel(reach.target) + (reach.skips.length ? ' (skips ' + reach.skips.map(stepLabel).join(', ') + ')' : '');
  }

  function inputOf(decision, name) {
    return (decision.inputs || []).find(function (input) { return input.name === name; }) || null;
  }
  /** One comparison in plain words, from the YAML shorthand. */
  function testText(label, test) {
    if (test === undefined || test === null) return label + ' is unset';
    if (typeof test === 'string' || typeof test === 'number') return label + ' is ' + test;
    if (Array.isArray(test)) return label + ' is ' + test.join(' or ');
    if (test.not !== undefined) return label + ' is not ' + [].concat(test.not).join(' or ');
    var parts = [];
    if (test.atLeast !== undefined) parts.push('at least ' + test.atLeast);
    if (test.above !== undefined) parts.push('above ' + test.above);
    if (test.atMost !== undefined) parts.push('at most ' + test.atMost);
    if (test.below !== undefined) parts.push('below ' + test.below);
    return label + ' is ' + parts.join(' and ');
  }
  function whenText(decision, when) {
    return Object.keys(when || {}).map(function (name) {
      var input = inputOf(decision, name);
      return testText(input ? (input.label || input.name) : name, when[name]);
    }).join(' and ');
  }

  /** The routes of a decision in plain words, one line each, for the board and its inspector. */
  function decisionLines(workflow, decision) {
    if (decision.kind === 'loop') {
      return ['↩ ' + stepLabel(decision.back) + ' until ' + whenText(decision, decision.goal) + ' (at most ' + (decision.maxRounds || 3) + ')',
        'Then ' + targetText(workflow, decision.after, 'next')];
    }
    if (decision.kind === 'ask') {
      return ['A person chooses:'].concat((decision.routes || []).map(function (route) { return route.label + ' → ' + targetText(workflow, decision.after, route.to); }));
    }
    return (decision.routes || []).map(function (route) {
      return (route.when ? 'If ' + whenText(decision, route.when) : 'Otherwise') + ' → ' + targetText(workflow, decision.after, route.to);
    });
  }

  /** A new decision after a step with sensible routes for its kind, ready to edit. */
  function newDecision(workflow, phaseId, kind) {
    var phases = workflow.phases; var at = phases.indexOf(phaseId);
    var last = at === phases.length - 1;
    var taken = (workflow.decisions || []).map(function (decision) { return decision.id; });
    var decision = { id: uniqueId(kebab('decide-after-' + phaseId), taken), after: phaseId, kind: kind };
    if (kind === 'loop') {
      decision.label = 'Repeat until it is done';
      decision.inputs = [{ name: 'done', label: 'Done', values: ['yes', 'no'] }];
      decision.goal = { done: 'yes' };
      decision.back = at > 0 ? phases[at - 1] : phaseId;
      decision.maxRounds = 3;
      return decision;
    }
    if (kind === 'ask') {
      decision.label = 'What should happen next?';
      // After the last step there is no next one: offer another round or finishing.
      decision.routes = last
        ? [{ id: 'again', label: 'Another round', to: phaseId }, { id: 'finish', label: 'Finish here', to: 'end' }]
        : [{ id: 'continue', label: 'Continue', to: 'next' }, { id: 'finish', label: 'Finish here', to: 'end' }];
      return decision;
    }
    decision.label = 'Which way next?';
    decision.inputs = [{ name: 'outcome', label: 'Outcome', values: ['yes', 'no'] }];
    decision.routes = [{ id: 'rule-1', label: 'Outcome is yes', when: { outcome: 'yes' }, to: last ? 'end' : 'next' },
      { id: 'otherwise', label: 'Otherwise', to: phases[at + 2] ? phases[at + 2] : 'end' }];
    return decision;
  }

  /** Change a decision's kind, keeping its name, values and who decides where they still apply. */
  function convertDecision(workflow, decision, kind) {
    var fresh = newDecision(workflow, decision.after, kind);
    fresh.id = decision.id;
    fresh.label = decision.label || fresh.label;
    if (decision.by) fresh.by = clone(decision.by);
    if (kind !== 'ask' && decision.enforceConditions) fresh.enforceConditions = true;
    if (kind !== 'ask' && decision.inputs && decision.inputs.length) {
      fresh.inputs = clone(kind === 'loop' ? decision.inputs.slice(0, 1) : decision.inputs);
      var first = fresh.inputs[0];
      var value = first.type === 'number' ? { atLeast: first.minimum !== undefined && first.minimum !== null ? first.minimum : 0 } : first.values[0];
      var when = {}; when[first.name] = value;
      if (kind === 'loop') fresh.goal = when;
      else { fresh.routes[0].when = when; fresh.routes[0].label = capitalize(whenText(fresh, when)); }
    }
    return fresh;
  }
  function capitalize(text) { text = String(text || ''); return text.charAt(0).toUpperCase() + text.slice(1); }

  function setDecision(workflow, decision, replacement) {
    workflow.decisions = (workflow.decisions || []).map(function (entry) { return entry === decision ? replacement : entry; });
    return replacement;
  }
  function removeDecision(workflow, decision) {
    workflow.decisions = (workflow.decisions || []).filter(function (entry) { return entry !== decision; });
  }

  /** Keep branch rule ids and labels in step with their rules, so nothing needs naming by hand. */
  function relabelRules(decision) {
    if (decision.kind !== 'branch') return;
    var last = decision.routes.length - 1;
    decision.routes.forEach(function (route, index) {
      if (index === last) { route.id = 'otherwise'; route.label = 'Otherwise'; delete route.when; return; }
      route.id = 'rule-' + (index + 1);
      route.label = capitalize(whenText(decision, route.when)).slice(0, 120) || 'Rule ' + (index + 1);
    });
  }

  // Comparisons as the inspector offers them, and their YAML shorthand.
  function operatorOptions(input) {
    if (input && input.type === 'number') return [{ value: 'is', label: 'is' }, { value: 'atLeast', label: 'is at least' }, { value: 'atMost', label: 'is at most' }, { value: 'above', label: 'is above' }, { value: 'below', label: 'is below' }];
    return [{ value: 'is', label: 'is' }, { value: 'not', label: 'is not' }];
  }
  function testOperator(test) {
    if (test && typeof test === 'object' && !Array.isArray(test)) {
      if (test.not !== undefined) return 'not';
      return ['atLeast', 'atMost', 'above', 'below'].find(function (key) { return test[key] !== undefined; }) || 'is';
    }
    return 'is';
  }
  function testValue(test) {
    if (test === undefined || test === null) return '';
    if (Array.isArray(test)) return String(test[0]);
    if (typeof test === 'object') { var key = testOperator(test); return String([].concat(key === 'not' ? test.not : test[key])[0]); }
    return String(test);
  }
  function buildTest(input, operator, value) {
    if (input.type === 'number') {
      var number = Number(value);
      if (!isFinite(number)) number = 0;
      if (operator === 'is') return number;
      var bound = {}; bound[operator] = number; return bound;
    }
    var choice = input.values.indexOf(value) >= 0 ? value : input.values[0];
    return operator === 'not' ? { not: choice } : choice;
  }

  /** The three controls of one comparison: which value, how it compares, and to what. */
  function conditionControls(decision, when, onChange, key) {
    var name = Object.keys(when || {})[0];
    var input = inputOf(decision, name) || (decision.inputs || [])[0];
    if (!input) return [el('span', { class: 'muted', text: 'Add a value the step records first.' })];
    var test = when ? when[input.name] : undefined;
    var operator = testOperator(test); var value = testValue(test);
    function commit(nextInput, nextOperator, nextValue) {
      var chosen = inputOf(decision, nextInput) || input;
      var operators = operatorOptions(chosen).map(function (option) { return option.value; });
      var updated = {}; updated[chosen.name] = buildTest(chosen, operators.indexOf(nextOperator) >= 0 ? nextOperator : 'is', nextValue);
      onChange(updated);
    }
    return [
      select(key + '-input', (decision.inputs || []).map(function (entry) { return { value: entry.name, label: entry.label || entry.name }; }), input.name, function (next) { commit(next, operator, value); }, { 'aria-label': 'Value to check' }),
      select(key + '-op', operatorOptions(input), operator, function (next) { commit(input.name, next, value); }, { 'aria-label': 'Comparison' }),
      input.type === 'number'
        ? textInput(key + '-value', value, function (next) { commit(input.name, operator, next); }, { 'aria-label': 'Number', style: 'width:72px' })
        : select(key + '-value', input.values.map(function (choice) { return { value: choice, label: choice }; }), value, function (next) { commit(input.name, operator, next); }, { 'aria-label': 'Choice' })
    ];
  }

  /** Where a route may go: the next step, a later one (naming what it skips), back, or the end. */
  function targetOptions(workflow, after, current) {
    var phases = workflow.phases; var from = phases.indexOf(after);
    var options = [];
    if (from + 1 < phases.length) options.push({ value: 'next', label: 'Next step: ' + stepLabel(phases[from + 1]) });
    phases.forEach(function (id, index) {
      if (index === from + 1) { if (current === id) options.push({ value: id, label: stepLabel(id) }); return; }
      if (index > from) options.push({ value: id, label: stepLabel(id) + ' (skips ' + phases.slice(from + 1, index).map(stepLabel).join(', ') + ')' });
      else options.push({ value: id, label: (index === from ? '↩ Redo ' : '↩ Back to ') + stepLabel(id) });
    });
    options.push({ value: 'end', label: 'Finish the Story' });
    if (current && !options.some(function (option) { return option.value === current; })) options.push({ value: current, label: stepLabel(current) + ' (not in this workflow)' });
    return options;
  }

  /** Rename a value and every rule that reads it, or change its choices and keep rules valid. */
  function renameInput(decision, index, label) {
    var input = decision.inputs[index];
    var taken = decision.inputs.filter(function (entry, at) { return at !== index; }).map(function (entry) { return entry.name; });
    var name = inputName(label, taken);
    var before = input.name;
    input.label = String(label).trim().slice(0, 120) || name;
    input.name = name;
    function rekey(when) { if (when && when[before] !== undefined) { when[name] = when[before]; if (name !== before) delete when[before]; } }
    (decision.routes || []).forEach(function (route) { rekey(route.when); });
    rekey(decision.goal);
  }
  function setChoices(decision, index, text) {
    var input = decision.inputs[index];
    var values = []; String(text || '').split(',').forEach(function (part) { var choice = part.trim(); if (choice && values.map(function (v) { return v.toLowerCase(); }).indexOf(choice.toLowerCase()) < 0) values.push(choice); });
    if (!values.length) return false;
    input.values = values.slice(0, 20);
    function keep(when) { if (when && when[input.name] !== undefined) when[input.name] = buildTest(input, testOperator(when[input.name]), testValue(when[input.name])); }
    (decision.routes || []).forEach(function (route) { keep(route.when); });
    keep(decision.goal);
    return true;
  }
  function setInputType(decision, index, type) {
    var input = decision.inputs[index];
    if (type === 'number') { delete input.values; input.type = 'number'; }
    else { delete input.type; delete input.minimum; delete input.maximum; input.values = ['yes', 'no']; }
    function reset(when) { if (when && when[input.name] !== undefined) when[input.name] = buildTest(input, 'is', type === 'number' ? '0' : input.values[0]); }
    (decision.routes || []).forEach(function (route) { reset(route.when); });
    reset(decision.goal);
  }

  /**
   * The people rules, checked as the person edits so the route that would be refused is visible
   * here: a rule may send work back, or skip a step people sign off, only after a step people
   * sign off. The engine applies the same rules when the change is checked.
   */
  function decisionWarnings(workflowId, workflow, decision) {
    var warnings = [];
    var signed = Boolean(stepSettings(workflowId, decision.after).approval.group);
    var routes = decision.kind === 'loop' ? [{ to: decision.back }, { to: 'next' }] : (decision.routes || []);
    var reaches = routes.map(function (route) { return reachOf(workflow, decision.after, route.to); });
    var goesBack = reaches.some(function (reach) { return reach.kind === 'back'; });
    if (decision.kind !== 'ask' && !signed) {
      if (goesBack) warnings.push('A rule can send work back only after a step people sign off. Give ' + stepLabel(decision.after) + ' a sign-off, or make this an Ask a person decision.');
      var gated = [];
      reaches.forEach(function (reach) { reach.skips.forEach(function (id) { if (stepSettings(workflowId, id).approval.group && gated.indexOf(id) < 0) gated.push(id); }); });
      if (gated.length) warnings.push('A rule can skip ' + gated.map(stepLabel).join(', ') + ', which people sign off, only after a step people sign off. Give ' + stepLabel(decision.after) + ' a sign-off, or make this an Ask a person decision.');
    }
    if ((decision.kind === 'ask' || goesBack) && !signed && !decision.by) warnings.push('Choose who decides: ' + stepLabel(decision.after) + ' has no sign-off to take people from.');
    reaches.forEach(function (reach) { if (reach.kind === 'missing') warnings.push(stepLabel(reach.target) + ' is not in this workflow any more; choose another step.'); });
    return warnings;
  }

  /** Drop or re-aim decisions that name a step the workflow no longer has. */
  function pruneDecisions(workflow, removedId) {
    var dropped = [];
    workflow.decisions = (workflow.decisions || []).filter(function (decision) {
      var uses = decision.after === removedId || decision.back === removedId
        || (decision.routes || []).some(function (route) { return route.to === removedId; });
      if (uses && decision.after !== removedId && decision.kind !== 'loop') {
        decision.routes.forEach(function (route) { if (route.to === removedId) route.to = 'next'; });
        return true;
      }
      if (uses) dropped.push(decision.label);
      return !uses;
    });
    return dropped;
  }

  function renameDecisionSteps(workflow, from, to) {
    (workflow.decisions || []).forEach(function (decision) {
      if (decision.after === from) decision.after = to;
      if (decision.back === from) decision.back = to;
      (decision.routes || []).forEach(function (route) { if (route.to === from) route.to = to; });
    });
  }

  function inputsEditor(decision) {
    var box = el('fieldset', { class: 'field decision-box' }, el('legend', { class: 'label', text: 'What ' + stepLabel(decision.after) + ' records' }));
    (decision.inputs || []).forEach(function (input, index) {
      box.appendChild(el('div', { class: 'decision-row' },
        textInput('dec-input-name-' + index, input.label || input.name, function (value) { if (value.trim()) { renameInput(decision, index, value); relabelRules(decision); changed(); } }, { 'aria-label': 'Name of the value', style: 'width:120px' }),
        select('dec-input-type-' + index, [{ value: 'choice', label: 'one of' }, { value: 'number', label: 'a number' }], input.type === 'number' ? 'number' : 'choice', function (value) { setInputType(decision, index, value); relabelRules(decision); changed(); }, { 'aria-label': 'Kind of value' }),
        input.type === 'number' ? null : textInput('dec-input-values-' + index, (input.values || []).join(', '), function (value) { if (setChoices(decision, index, value)) { relabelRules(decision); changed(); } else setStatus('List at least one choice, separated by commas.'); }, { 'aria-label': 'Choices separated by commas', placeholder: 'low, medium, high' }),
        decision.kind === 'branch' && decision.inputs.length > 1 ? button('Remove', function () {
          var name = input.name;
          decision.inputs.splice(index, 1);
          decision.routes.forEach(function (route) { if (route.when && route.when[name] !== undefined) { route.when = {}; route.when[decision.inputs[0].name] = buildTest(decision.inputs[0], 'is', ''); } });
          relabelRules(decision); changed();
        }, { class: 'secondary', 'aria-label': 'Remove ' + (input.label || input.name) }) : null));
    });
    if (decision.kind === 'branch' && decision.inputs.length < 10) {
      box.appendChild(button('Add a value', function () {
        var taken = decision.inputs.map(function (entry) { return entry.name; });
        decision.inputs.push({ name: inputName('value', taken), label: 'Value ' + (decision.inputs.length + 1), values: ['yes', 'no'] });
        changed();
      }, { class: 'secondary' }));
    }
    box.appendChild(el('span', { class: 'hint', text: 'The agent records these when it submits the step, and the person who signs it off sees them.' }));
    return box;
  }

  function renderDecisionInspector(workflowId, decision) {
    var workflow = state.draft.workflows[workflowId];
    var aside = el('aside', { class: 'inspector properties', 'aria-label': 'Decision settings' });
    aside.appendChild(propTitle('purple', 'diamond', 'DECISION AFTER ' + stepLabel(decision.after).toUpperCase(), decision.label));
    var body = el('div', { class: 'prop-body decision-body' });
    aside.appendChild(body);
    body.appendChild(field('dec-name', 'Question', textInput('dec-name', decision.label, function (value) { if (value.trim()) { decision.label = value.trim().slice(0, 120); changed(); } })));
    body.appendChild(field('dec-kind', 'Kind', select('dec-kind', DECISION_KINDS, decision.kind, function (value) {
      var converted = setDecision(workflow, decision, convertDecision(workflow, decision, value));
      relabelRules(converted); state.decision = converted.id; changed();
    }), decision.kind === 'branch' ? 'Rules read values the step records and choose the next step; the last one takes everything else.'
      : decision.kind === 'loop' ? 'Goes back until the goal is met. When the rounds are used up, a person chooses.'
        : 'The Story waits, and someone you choose picks one of the options.'));
    if (decision.kind !== 'ask') {
      body.appendChild(inputsEditor(decision));
      body.appendChild(el('label', { class: 'field', style: 'display:flex;gap:6px;align-items:center;font-size:13px' },
        el('input', { type: 'checkbox', 'data-key': 'dec-enforce-conditions', checked: decision.enforceConditions === true, onchange: function (event) { if (event.target.checked) decision.enforceConditions = true; else delete decision.enforceConditions; changed(); } }),
        'Human choices must match the recorded verdict (no failed-result override)'));
    }
    if (decision.kind === 'branch') {
      var rules = el('fieldset', { class: 'field decision-box' }, el('legend', { class: 'label', text: 'Rules, checked in order' }));
      decision.routes.slice(0, -1).forEach(function (route, index) {
        rules.appendChild(el('div', { class: 'decision-row' },
          el('span', { class: 'muted', text: index === 0 ? 'If' : 'Else if' }),
          conditionControls(decision, route.when, function (when) { route.when = when; relabelRules(decision); changed(); }, 'dec-rule-' + index),
          el('span', { class: 'muted', text: 'go to' }),
          select('dec-rule-' + index + '-to', targetOptions(workflow, decision.after, route.to), route.to, function (value) { route.to = value; changed(); }, { 'aria-label': 'Next step when this rule holds' }),
          decision.routes.length > 2 ? button('Remove', function () { decision.routes.splice(index, 1); relabelRules(decision); changed(); }, { class: 'secondary', 'aria-label': 'Remove this rule' }) : null));
      });
      if (decision.routes.length < 10) {
        rules.appendChild(button('Add a rule', function () {
          var first = decision.inputs[0]; var when = {}; when[first.name] = buildTest(first, 'is', first.type === 'number' ? '0' : first.values[first.values.length - 1]);
          decision.routes.splice(decision.routes.length - 1, 0, { id: 'rule', label: 'Rule', when: when, to: 'next' });
          relabelRules(decision); changed();
        }, { class: 'secondary' }));
      }
      var otherwise = decision.routes[decision.routes.length - 1];
      rules.appendChild(el('div', { class: 'decision-row' }, el('span', { class: 'muted', text: 'Otherwise go to' }),
        select('dec-otherwise', targetOptions(workflow, decision.after, otherwise.to), otherwise.to, function (value) { otherwise.to = value; changed(); }, { 'aria-label': 'Next step otherwise' })));
      body.appendChild(rules);
    }
    if (decision.kind === 'loop') {
      var phases = workflow.phases; var from = phases.indexOf(decision.after);
      body.appendChild(el('fieldset', { class: 'field decision-box' }, el('legend', { class: 'label', text: 'Goal' }),
        el('div', { class: 'decision-row' }, el('span', { class: 'muted', text: 'Until' }),
          conditionControls(decision, decision.goal, function (when) { decision.goal = when; changed(); }, 'dec-goal'))));
      body.appendChild(el('div', { class: 'grid-2' },
        field('dec-back', 'Otherwise go back to', select('dec-back', phases.slice(0, Math.max(0, from) + 1).map(function (id) { return { value: id, label: id === decision.after ? 'Redo ' + stepLabel(id) : stepLabel(id) }; }), decision.back, function (value) { decision.back = value; changed(); })),
        field('dec-rounds', 'At most', select('dec-rounds', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (count) { return { value: String(count), label: count + (count === 1 ? ' round' : ' rounds') }; }), String(decision.maxRounds || 3), function (value) { decision.maxRounds = Number(value); changed(); }))));
    }
    if (decision.kind === 'ask') {
      var options = el('fieldset', { class: 'field decision-box' }, el('legend', { class: 'label', text: 'Options the person chooses from' }));
      decision.routes.forEach(function (route, index) {
        options.appendChild(el('div', { class: 'decision-row' },
          textInput('dec-option-' + index, route.label, function (value) {
            if (!value.trim()) return;
            route.label = value.trim().slice(0, 120);
            route.id = uniqueId(kebab(value) || 'option', decision.routes.filter(function (other) { return other !== route; }).map(function (other) { return other.id; }));
            changed();
          }, { 'aria-label': 'Option name', style: 'width:140px' }),
          el('span', { class: 'muted', text: 'goes to' }),
          select('dec-option-' + index + '-to', targetOptions(workflow, decision.after, route.to), route.to, function (value) { route.to = value; changed(); }, { 'aria-label': 'Where this option goes' }),
          decision.routes.length > 2 ? button('Remove', function () { decision.routes.splice(index, 1); changed(); }, { class: 'secondary', 'aria-label': 'Remove ' + route.label }) : null));
      });
      if (decision.routes.length < 10) {
        options.appendChild(button('Add an option', function () {
          var taken = decision.routes.map(function (route) { return route.id; });
          decision.routes.push({ id: uniqueId('option', taken), label: 'Option ' + (decision.routes.length + 1), to: 'next' });
          changed();
        }, { class: 'secondary' }));
      }
      options.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' },
        el('input', { type: 'checkbox', 'data-key': 'dec-any-step', checked: decision.anyStep === true, onchange: function (event) { if (event.target.checked) decision.anyStep = true; else delete decision.anyStep; changed(); } }),
        'They may also pick any other step'));
      body.appendChild(options);
    }
    var goesBack = decision.kind === 'loop' || (decision.routes || []).some(function (route) { return reachOf(workflow, decision.after, route.to).kind === 'back'; });
    if (decision.kind === 'branch' && goesBack) {
      body.appendChild(field('dec-branch-rounds', 'Going back at most', select('dec-branch-rounds', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (count) { return { value: String(count), label: count + (count === 1 ? ' time' : ' times') }; }), String(decision.maxRounds || 3), function (value) { decision.maxRounds = Number(value); changed(); }), 'Then a person chooses.'));
    } else if (decision.kind === 'branch' && decision.maxRounds) {
      delete decision.maxRounds;
    }
    if (decision.kind === 'ask' || goesBack) {
      var by = decision.by ? [].concat(decision.by)[0] : '';
      var owner = stepSettings(workflowId, decision.after).approval.group;
      body.appendChild(field('dec-by', decision.kind === 'ask' ? 'Who chooses' : 'Who chooses when the rounds are used up',
        select('dec-by', [{ value: '', label: owner ? 'Whoever signs off ' + stepLabel(decision.after) : 'Choose a group…' }].concat(Object.keys(state.draft.groups).map(function (id) { return { value: id, label: state.draft.groups[id].label }; })), by, function (value) { if (value) decision.by = [value]; else delete decision.by; changed(); })));
    }
    decisionWarnings(workflowId, workflow, decision).forEach(function (warning) { body.appendChild(el('div', { class: 'callout bad', text: warning })); });
    body.appendChild(el('div', { class: 'callout' }, decisionLines(workflow, decision).map(function (line) { return el('div', { text: line }); })));
    body.appendChild(el('div', { class: 'studio-row' },
      button('Back to the step', function () { state.decision = null; render(); }, { class: 'secondary' }),
      button('Remove decision', function () { removeDecision(workflow, decision); state.decision = null; changed(); }, { class: 'secondary' })));
    return aside;
  }

  // ---- Canvas: a workflow as connected steps -------------------------------------------------
  //
  // Steps are nodes, left to right in the workflow's order. Each shows what it produces, the agent
  // that drafts it and who signs it off. Arrows show the order; a decision is a diamond on the arrow
  // after its step; a route that skips ahead runs above the row, and a route or send-back rule that
  // goes back runs below it. The canvas pans and zooms; dropping a step on another moves it there,
  // because the order is still the workflow's list of steps.

  // A step card, and a minimized step: a short pill on the same centre line.
  var NODE_W = 212, NODE_H = 136, MINI_W = 188, MINI_H = 38, GAP = 56, DECISION_GAP = 100, CANVAS_PAD = 40, LOOP_STEP = 26, FINISH_W = 84;
  var PANEL_MIN = 300, PANEL_MAX = 680, RETURN_PAD = 26, ROW_GAP = 34, STUB_STEP = 24;
  var OUTPUT_LOOK = {
    document: { label: 'Writes a document', icon: 'doc', tone: 'blue' },
    analysis: { label: 'Writes an analysis', icon: 'chart', tone: 'cyan' },
    code: { label: 'Changes code', icon: 'code', tone: 'green' },
    none: { label: 'Sign-off only', icon: 'check', tone: 'yellow' }
  };
  var ICON_PATHS = {
    doc: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6',
    chart: 'M4 20V11 M10 20V5 M16 20v-7 M21 20H3',
    code: 'M8 8l-5 4 5 4 M16 8l5 4-5 4 M13.5 5l-3 14',
    check: 'M5 12.5l4 4 10-10',
    people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 20a6 6 0 0 1 12 0 M16 5.2a3 3 0 0 1 0 5.6 M21 20a6 6 0 0 0-3.5-5.4',
    agent: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
    flow: 'M3 4h7v6H3z M14 14h7v6h-7z M10 7h4a3 3 0 0 1 3 3v4',
    book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z M5 19.5A1.5 1.5 0 0 0 6.5 21H19 M9 7h6',
    list: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
    plus: 'M12 5v14 M5 12h14',
    minus: 'M5 12h14',
    diamond: 'M12 3l9 9-9 9-9-9z',
    back: 'M9 14l-5-5 5-5 M4 9h11a5 5 0 0 1 0 10h-3',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 13.5l1.6 1.2-2 3.5-1.9-.8a7.6 7.6 0 0 1-1.7 1l-.3 2.1h-4l-.3-2.1a7.6 7.6 0 0 1-1.7-1l-1.9.8-2-3.5 1.6-1.2a7.4 7.4 0 0 1 0-3L3 9.3l2-3.5 1.9.8a7.6 7.6 0 0 1 1.7-1L8.9 3.5h4l.3 2.1a7.6 7.6 0 0 1 1.7 1l1.9-.8 2 3.5-1.6 1.2a7.4 7.4 0 0 1 0 3z',
    fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
    trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    flag: 'M5 21V4 M5 4h11l-2 4 2 4H5',
    up: 'M6 15l6-6 6 6',
    down: 'M6 9l6 6 6-6',
    foldAll: 'M7 11l5-5 5 5 M7 18l5-5 5 5',
    unfoldAll: 'M7 6l5 5 5-5 M7 13l5 5 5-5',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 7.5h.01',
    panel: 'M3 4h18v16H3z M15 4v16',
    wrap: 'M4 6h16 M4 12h13a3 3 0 0 1 0 6h-5 M12 15l-3 3 3 3 M4 18h4',
    send: 'M21 3L10 14 M21 3l-6.5 18-4.5-7-7-4.5z',
    plug: 'M9 3v5 M15 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4',
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'
  };

  function svgEl(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, String(attrs[key])); });
    return node;
  }
  function icon(name, size) {
    var svg = svgEl('svg', { viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
    svg.appendChild(svgEl('path', { d: ICON_PATHS[name] || ICON_PATHS.doc }));
    return svg;
  }

  /** How one workflow's canvas is panned and zoomed; kept per workflow while the Studio is open. */
  function canvasView(workflowId) {
    var views = state.canvas || (state.canvas = {});
    return views[workflowId] || (views[workflowId] = { zoom: 1, panX: 56, panY: 0, fitted: false, finding: false, find: '', reveal: null });
  }
  function wrapWidthFor(view) {
    if (view.width) return view.width;
    var panel = state.panelHidden ? 50 : (state.panelWidth || 380) + 10;
    return Math.max(NODE_W + 2 * CANVAS_PAD, (window.innerWidth || 1200) - 56 - 40 - panel);
  }
  function transformOf(view) { return 'translate(' + Math.round(view.panX) + 'px,' + Math.round(view.panY) + 'px) scale(' + view.zoom + ')'; }

  /** Where each step sits and how every arrow runs: order, send-back rules and decision routes. A
   *  minimized step is a short pill on the same centre line, so the arrows still run straight. Given
   *  a width, the steps wrap into rows that read left to right like text: the arrow from the end of
   *  one row returns to the start of the next, and a route between rows is a labelled stub instead
   *  of a line across the canvas. */
  function canvasLayout(workflow, collapsed, wrapWidth) {
    var phases = workflow.phases; var folded = collapsed || {};
    var startX = CANVAS_PAD + (wrapWidth ? RETURN_PAD : 0);
    var limit = wrapWidth ? Math.max(wrapWidth - CANVAS_PAD, startX + NODE_W) : Infinity;
    var nodes = []; var x = startX; var row = 0; var inRow = 0;
    function place(w, gap) {
      if (inRow && x + w > limit) { row += 1; x = startX; inRow = 0; }
      var at = { x: x, row: row }; x += w + gap; inRow += 1;
      return at;
    }
    phases.forEach(function (phaseId, index) {
      var mini = Boolean(folded[phaseId]); var w = mini ? MINI_W : NODE_W;
      var at = place(w, decisionAfterStep(workflow, phaseId) ? DECISION_GAP : GAP);
      nodes.push({ id: phaseId, index: index, x: at.x, row: at.row, w: w, h: mini ? MINI_H : NODE_H, collapsed: mini });
    });
    var finishAt = place(FINISH_W, 0);
    var finish = { x: finishAt.x, row: finishAt.row, w: FINISH_W, h: 36, finish: true };
    function rowOf(index) { return index >= nodes.length ? finish.row : nodes[index].row; }
    var rows = []; for (var r = 0; r <= finish.row; r += 1) rows.push({ above: 0, below: 0, stubsAbove: 0, stubsBelow: 0 });
    var edges = []; var stubs = {};
    phases.forEach(function (phaseId, index) {
      var decision = decisionAfterStep(workflow, phaseId);
      edges.push({ kind: 'next', from: index, to: index + 1, decision: decision ? decision.id : null });
    });
    function lane(edge, down) {
      if (rowOf(edge.from) === rowOf(edge.to)) {
        var own = rows[rowOf(edge.from)];
        if (down) { own.below += 1; edge.depth = own.below; } else { own.above += 1; edge.depth = own.above; }
      } else {
        // Stubs leaving the same step stack outward, one label high each.
        var key = edge.from + (down ? 'v' : '^'); var line = rows[rowOf(edge.from)];
        edge.stub = true; edge.depth = 1; edge.stubIndex = stubs[key] || 0; stubs[key] = edge.stubIndex + 1;
        if (down) line.stubsBelow = Math.max(line.stubsBelow, stubs[key]); else line.stubsAbove = Math.max(line.stubsAbove, stubs[key]);
        edge.stubLabel = edge.kind === 'send-back' ? edge.label : edge.label + ' \u2192 ' + (edge.to >= phases.length ? 'Finish' : stepLabel(phases[edge.to]));
      }
      edges.push(edge);
    }
    (workflow.reworkLoops || []).forEach(function (loop) {
      var from = phases.indexOf(loop.from); var to = phases.indexOf(loop.to);
      if (from < 0 || to < 0) return;
      lane({ kind: 'send-back', from: from, to: to, step: loop.from, label: 'If rejected, back to ' + stepLabel(loop.to),
        title: 'If ' + stepLabel(loop.from) + ' is rejected, it goes back to ' + stepLabel(loop.to) + ', at most ' + loop.maxAttempts + (loop.maxAttempts === 1 ? ' time' : ' times') }, true);
    });
    (workflow.decisions || []).forEach(function (decision) {
      var after = phases.indexOf(decision.after);
      if (after < 0) return;
      var routes = decision.kind === 'loop' ? [{ label: 'Until ' + whenText(decision, decision.goal), to: decision.back }] : (decision.routes || []);
      routes.forEach(function (route) {
        // A route to the next step, or to the end after the last one, follows the arrow already drawn.
        var reach = reachOf(workflow, decision.after, route.to);
        if (route.to === 'next' || reach.kind === 'next' || reach.kind === 'missing' || (reach.kind === 'end' && !reach.skips.length)) return;
        if (reach.kind === 'back') {
          lane({ kind: 'decision-back', from: after, to: phases.indexOf(reach.target), decision: decision.id, label: route.label }, true);
          return;
        }
        lane({ kind: reach.kind === 'end' ? 'decision-end' : 'decision-skip', from: after, to: reach.kind === 'end' ? phases.length : phases.indexOf(reach.target), decision: decision.id, label: route.label }, false);
      });
    });
    var cursor = CANVAS_PAD; var width = 0;
    rows.forEach(function (line, index) {
      var members = nodes.filter(function (node) { return node.row === index; });
      if (finish.row === index) members = members.concat([finish]);
      line.h = members.reduce(function (tallest, node) { return Math.max(tallest, node.h); }, members.length ? 0 : NODE_H);
      line.lanesAbove = line.above ? line.above * LOOP_STEP + 14 : 0;
      line.top = cursor + line.lanesAbove + (line.stubsAbove ? line.stubsAbove * STUB_STEP + 6 : 0);
      line.middle = line.top + line.h / 2;
      members.forEach(function (node) { node.y = line.middle - node.h / 2; width = Math.max(width, node.x + node.w); });
      line.lanesBelow = line.below ? line.below * LOOP_STEP + 24 : 0;
      line.bottom = line.top + line.h + line.lanesBelow + (line.stubsBelow ? line.stubsBelow * STUB_STEP + 8 : 0);
      line.returnY = line.bottom + 16;
      cursor = line.bottom + (index < rows.length - 1 ? ROW_GAP : 0);
    });
    return { nodes: nodes, edges: edges, rows: rows, finish: finish, finishX: finish.x, rowY: rows[0].top, rowH: rows[0].h, middle: rows[0].middle,
      above: rows[0].above, below: rows[0].below, width: width + CANVAS_PAD, height: cursor + CANVAS_PAD };
  }

  /** The path of one arrow, and the point its label sits on. */
  function edgeGeometry(layout, edge) {
    function box(index) { return index >= layout.nodes.length ? layout.finish : layout.nodes[index]; }
    var from = box(edge.from); var to = box(edge.to); var line = layout.rows[from.row];
    if (edge.kind === 'next') {
      var start = from.x + from.w;
      if (to.row === from.row) return { d: 'M' + start + ' ' + line.middle + ' H' + (to.x - 2), tone: 'next', x: (start + to.x) / 2, y: line.middle };
      // From the end of a row back to the start of the next, beneath anything hanging off the row.
      var out = start + (edge.decision ? DECISION_GAP / 2 + 14 : 18); var next = layout.rows[to.row];
      return { d: 'M' + start + ' ' + line.middle + ' H' + out + ' V' + line.returnY + ' H' + (to.x - 18) + ' V' + next.middle + ' H' + (to.x - 2),
        tone: 'next', x: start + (edge.decision ? DECISION_GAP / 2 : 9), y: line.middle };
    }
    var up = edge.kind === 'decision-skip' || edge.kind === 'decision-end';
    if (edge.stub) {
      // Beyond the row's own lanes, so a stub never sits on a line drawn within the row.
      var sx = from.x + from.w * (up ? 0.7 : 0.3);
      if (up) {
        var ly = line.top - line.lanesAbove - 14 - edge.stubIndex * STUB_STEP;
        return { d: 'M' + sx + ' ' + from.y + ' V' + (ly + 9), tone: 'decision', x: sx, y: ly, stub: true };
      }
      var base = from.y + from.h; var dy = line.top + line.h + line.lanesBelow + 16 + edge.stubIndex * STUB_STEP;
      return { d: 'M' + sx + ' ' + base + ' V' + (dy - 9), tone: edge.kind === 'send-back' ? 'send-back' : 'decision', x: sx, y: dy, stub: true, dashed: edge.kind === 'decision-back' };
    }
    // Arrows at different depths leave and land a little apart, so stacked ones stay distinguishable.
    var shift = ((edge.depth - 1) % 4) * 8;
    if (up) {
      var y = line.top - edge.depth * LOOP_STEP;
      var x1 = from.x + from.w * 0.7 + shift;
      var x2 = to.finish ? to.x + to.w / 2 - shift : to.x + to.w * 0.3 - shift;
      return { d: 'M' + x1 + ' ' + from.y + ' V' + y + ' H' + x2 + ' V' + (to.y - 2), tone: 'decision', x: (x1 + x2) / 2, y: y };
    }
    var low = line.top + line.h + edge.depth * LOOP_STEP;
    var self = edge.from === edge.to;
    var x3 = from.x + (self ? from.w * 0.62 + shift : from.w * 0.3 - shift);
    var x4 = to.x + (self ? to.w * 0.38 - shift : to.w * 0.7 + shift);
    return { d: 'M' + x3 + ' ' + (from.y + from.h) + ' V' + low + ' H' + x4 + ' V' + (to.y + to.h + 2), tone: edge.kind === 'send-back' ? 'send-back' : 'decision', x: (x3 + x4) / 2, y: low, dashed: edge.kind === 'decision-back' };
  }

  function renderEdges(layout) {
    var svg = svgEl('svg', { class: 'edges', width: layout.width, height: layout.height, viewBox: '0 0 ' + layout.width + ' ' + layout.height, 'aria-hidden': 'true', focusable: 'false' });
    var defs = svgEl('defs');
    ['next', 'send-back', 'decision'].forEach(function (tone) {
      var marker = svgEl('marker', { id: 'head-' + tone, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto' });
      marker.appendChild(svgEl('path', { d: 'M0 0 L10 5 L0 10 z', class: 'head-' + tone }));
      defs.appendChild(marker);
    });
    svg.appendChild(defs);
    layout.edges.forEach(function (edge) {
      var shape = edgeGeometry(layout, edge);
      svg.appendChild(svgEl('path', { d: shape.d, class: 'edge edge-' + shape.tone + (shape.dashed ? ' dashed' : ''), 'marker-end': shape.stub ? null : 'url(#head-' + shape.tone + ')' }));
    });
    return svg;
  }

  function selectStep(phaseId) { state.step = phaseId; state.decision = null; state.panel = null; render(); }
  function openDecision(decision) { if (!decision) return; state.step = decision.after; state.decision = decision.id; state.panel = null; render(); }
  function findMatches(view, phase, agent) {
    var query = String(view.find || '').trim().toLowerCase();
    return Boolean(query) && (String(phase.label).toLowerCase().indexOf(query) >= 0 || Boolean(agent && agent.label.toLowerCase().indexOf(query) >= 0));
  }

  /** What happens once a step is done, as chips on its card: where the Story goes next, and where
   *  rejected work returns. */
  function afterChips(workflow, phaseId, index) {
    var chips = [];
    var decision = decisionAfterStep(workflow, phaseId);
    if (decision) chips.push({ tone: 'decision', icon: 'diamond', text: decision.label, title: 'Then decides: ' + decision.label });
    else if (index === workflow.phases.length - 1) chips.push({ tone: 'route', icon: 'flag', text: 'Finish', title: 'Then the Story finishes' });
    else chips.push({ tone: 'route', icon: 'right', text: stepLabel(workflow.phases[index + 1]), title: 'Then goes on to ' + stepLabel(workflow.phases[index + 1]) });
    (workflow.reworkLoops || []).filter(function (loop) { return loop.from === phaseId; }).forEach(function (loop) {
      chips.push({ tone: 'back', icon: 'back', text: stepLabel(loop.to), title: 'If rejected, back to ' + stepLabel(loop.to) + ', at most ' + loop.maxAttempts + (loop.maxAttempts === 1 ? ' time' : ' times') });
    });
    var actions = (state.draft.steps[workflow.id] && state.draft.steps[workflow.id][phaseId] && state.draft.steps[workflow.id][phaseId].afterStep) || [];
    if (actions.length) {
      var crowded = chips.some(function (entry) { return entry.tone === 'back'; });
      chips.push({ tone: 'action', icon: 'send', count: actions.length, text: crowded ? String(actions.length) : actions.length === 1 ? actions[0].target : actions.length + ' actions',
        title: 'Sends after it: ' + actions.map(actionLine).join('; ') });
    }
    return chips;
  }
  function chip(entry) {
    return el('span', { class: 'chip chip-' + entry.tone, title: entry.title }, icon(entry.icon, 11), el('span', { class: 'chip-text', text: entry.text }));
  }
  /** Which steps of a workflow are minimized on the canvas; kept while the Studio is open. */
  function collapsedOf(workflowId) { var all = state.collapsed || (state.collapsed = {}); return all[workflowId] || (all[workflowId] = {}); }
  function setCollapsed(workflowId, phaseIds, on) {
    var folded = collapsedOf(workflowId);
    phaseIds.forEach(function (phaseId) { if (on) folded[phaseId] = true; else delete folded[phaseId]; });
  }

  function renderNode(workflowId, workflow, node, layout, view) {
    var phaseId = node.id; var phases = workflow.phases;
    var phase = state.draft.phases[phaseId] || { label: phaseId, output: 'document' };
    var look = OUTPUT_LOOK[stepOutput(workflowId, phaseId)] || OUTPUT_LOOK.document;
    var agent = state.draft.agents[phase.agent];
    var settings = stepSettings(workflowId, phaseId);
    var group = settings.approval.group ? state.draft.groups[settings.approval.group] : null;
    var blocked = Boolean(group && groupBlocked(settings.approval.group));
    var selected = state.step === phaseId && !state.decision && !state.panel;
    var minimum = settings.approval.minimum || 1;
    var others = groupsOf(settings.approval).length - 1;
    var signText = !group ? 'No sign-off' : blocked ? 'Nobody can approve it yet'
      : minimum + (minimum === 1 ? ' approval' : ' approvals') + ' from ' + group.label + (others > 0 ? ' and ' + others + (others === 1 ? ' other group' : ' other groups') : '');
    var asks = Boolean(phase.clarification && phase.clarification !== 'off');
    var skills = stepSkillEntries(phase.agent, phaseId, workflowId).filter(function (entry, at, all) { return all.findIndex(function (other) { return other.id === entry.id; }) === at; });
    var chips = afterChips(workflow, phaseId, node.index);
    var then = chips.map(function (entry) { return entry.title; }).join('; ');
    var decisionChip = chips.find(function (entry) { return entry.tone === 'decision'; });
    var backChip = chips.find(function (entry) { return entry.tone === 'back'; });
    var actionChip = chips.find(function (entry) { return entry.tone === 'action'; });
    var inside = node.collapsed ? [
      el('span', { class: 'node-icon' }, icon(look.icon, 12)),
      el('span', { class: 'node-num', text: String(node.index + 1) }),
      el('span', { class: 'node-title', text: phase.label }),
      el('span', { class: 'node-marks' },
        group ? el('span', { class: 'mark-chip' + (blocked ? ' bad' : ''), title: signText }, icon('people', 11), String(minimum)) : null,
        decisionChip ? el('span', { class: 'mark-chip decision', title: decisionChip.title }, icon('diamond', 10)) : null,
        backChip ? el('span', { class: 'mark-chip back', title: backChip.title }, icon('back', 11)) : null,
        actionChip ? el('span', { class: 'mark-chip action', title: actionChip.title }, icon('send', 10), String(actionChip.count)) : null)
    ] : [
      el('span', { class: 'node-head' }, el('span', { class: 'node-icon' }, icon(look.icon, 14)), el('span', { class: 'node-step', text: 'STEP ' + (node.index + 1) }),
        phase.isNew || phase.fromBlueprint ? el('span', { class: 'pill new', text: 'NEW' }) : null,
        settings.authoringSkill ? el('span', { class: 'pill skill', title: 'Drafted with /' + settings.authoringSkill, text: '/' + settings.authoringSkill }) : null),
      el('span', { class: 'node-title', text: phase.label }),
      el('span', { class: 'node-meta' },
        el('span', { class: 'node-agent', title: agent ? agent.label : 'Choose an agent' }, el('span', { class: 'avatar', text: agent ? initials(agent.label) : '?' }), el('span', { class: 'name', text: agent ? agent.label : 'Choose an agent' })),
        asks ? el('span', { class: 'node-asks', title: 'Asks clarifying questions before drafting' }, '?') : null,
        skills.length ? el('span', { class: 'node-skills', title: 'Skills: ' + skills.map(function (entry) { return skillLabel(entry.id); }).join(', ') }, icon('spark', 11), String(skills.length)) : null,
        el('span', { class: 'node-sign' + (blocked ? ' bad' : group ? '' : ' none'), title: signText }, icon(group ? 'people' : 'right', 11), group ? String(minimum) : 'auto')),
      el('span', { class: 'node-after' }, el('span', { class: 'lane', text: 'THEN' }), chips.map(chip))
    ];
    var card = el('div', {
      class: 'node tone-' + look.tone + (node.collapsed ? ' collapsed' : '') + (selected ? ' selected' : '') + (blocked ? ' blocked' : '') + (findMatches(view, phase, agent) ? ' match' : ''),
      draggable: 'true', 'data-phase': phaseId,
      ondragstart: function (event) { event.dataTransfer.setData('text/plain', phaseId); event.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); },
      ondragend: function () { card.classList.remove('dragging'); },
      ondragover: function (event) { event.preventDefault(); card.classList.add('drop-target'); },
      ondragleave: function () { card.classList.remove('drop-target'); },
      ondrop: function (event) {
        event.preventDefault(); card.classList.remove('drop-target');
        var moved = event.dataTransfer.getData('text/plain'); var from = phases.indexOf(moved);
        if (from >= 0 && from !== node.index) moveStep(workflowId, moved, node.index - from);
      }
    },
      el('button', {
        type: 'button', class: 'node-main', 'data-key': 'node-' + phaseId, 'aria-pressed': selected ? 'true' : 'false', title: node.collapsed ? phase.label : null,
        'aria-label': 'Step ' + (node.index + 1) + ' of ' + phases.length + ': ' + phase.label + '. ' + look.label + ', drafted by ' + (agent ? agent.label : 'no agent yet') + '. ' + signText + '. ' + then + '.',
        onclick: function () { selectStep(phaseId); },
        onkeydown: function (event) {
          var next = event.key === 'ArrowRight' ? node.index + 1 : event.key === 'ArrowLeft' ? node.index - 1 : -1;
          if (next < 0 || next >= phases.length) return;
          event.preventDefault(); state.focusKey = 'node-' + phases[next]; view.reveal = phases[next]; selectStep(phases[next]);
        }
      }, inside),
      el('button', { type: 'button', class: 'node-fold', 'data-key': 'fold-' + phaseId, 'aria-expanded': node.collapsed ? 'false' : 'true',
        title: node.collapsed ? 'Expand ' + phase.label : 'Minimize ' + phase.label, 'aria-label': (node.collapsed ? 'Expand ' : 'Minimize ') + phase.label,
        onclick: function (event) { event.stopPropagation(); setCollapsed(workflowId, [phaseId], !node.collapsed); state.focusKey = 'fold-' + phaseId; render(); } }, icon(node.collapsed ? 'down' : 'up', 12)),
      el('div', { class: 'node-tools' },
        el('button', { type: 'button', title: 'Move earlier', 'aria-label': 'Move ' + phase.label + ' earlier', disabled: node.index === 0, onclick: function () { moveStep(workflowId, phaseId, -1); } }, icon('left', 14)),
        el('button', { type: 'button', title: 'Move later', 'aria-label': 'Move ' + phase.label + ' later', disabled: node.index === phases.length - 1, onclick: function () { moveStep(workflowId, phaseId, 1); } }, icon('right', 14)),
        el('button', { type: 'button', title: 'Remove from this workflow', 'aria-label': 'Remove ' + phase.label + ' from this workflow', onclick: function () { removeStep(workflowId, phaseId); } }, icon('trash', 14))));
    card.style.cssText = 'left:' + node.x + 'px;top:' + node.y + 'px;width:' + node.w + 'px;height:' + node.h + 'px';
    return card;
  }

  function renderToolRail(workflowId, workflow, view) {
    var selected = workflow.phases.indexOf(state.step) >= 0 ? state.step : null;
    var existing = selected ? decisionAfterStep(workflow, selected) : null;
    var signed = Boolean(selected && stepSettings(workflowId, selected).approval.group);
    var folded = collapsedOf(workflowId);
    var allFolded = workflow.phases.length > 0 && workflow.phases.every(function (phaseId) { return folded[phaseId]; });
    function tool(name, label, onClick, attrs) {
      return el('button', Object.assign({ type: 'button', class: 'tool', title: label, 'aria-label': label, onclick: onClick }, attrs || {}), icon(name, 18));
    }
    return el('div', { class: 'tool-rail', role: 'toolbar', 'aria-label': 'Workflow tools', 'aria-orientation': 'vertical' },
      tool('plus', selected ? 'Add a step after ' + stepLabel(selected) : 'Add a step', function () {
        state.panel = 'add'; state.decision = null; if (state.adding) state.adding.after = selected; render();
      }, { 'aria-pressed': state.panel === 'add' ? 'true' : 'false' }),
      tool('diamond', !selected ? 'Select a step to decide what happens after it' : existing ? 'Open the decision after ' + stepLabel(selected) : 'Decide what happens after ' + stepLabel(selected), function () {
        if (existing) { openDecision(existing); return; }
        // After the last step the useful question is 'another round or finish?', which a person answers.
        var decision = newDecision(workflow, selected, workflow.phases.indexOf(selected) === workflow.phases.length - 1 ? 'ask' : 'branch');
        workflow.decisions = (workflow.decisions || []).concat([decision]);
        state.decision = decision.id; state.panel = null; changed();
      }, { disabled: !selected }),
      tool('back', signed ? 'Send rejected work from ' + stepLabel(selected) + ' back to an earlier step' : 'Only a step with a sign-off can send work back', function () {
        state.panel = null; state.decision = null; state.sections.signoff = true; state.focusKey = 'step-back'; render();
      }, { disabled: !signed || workflow.phases.indexOf(selected) === 0 }),
      tool('search', 'Find a step or agent', function () {
        view.finding = !view.finding; if (view.finding) state.focusKey = 'canvas-find'; else view.find = ''; render();
      }, { 'aria-pressed': view.finding ? 'true' : 'false' }),
      tool('gear', 'Workflow settings: name, description and rules', function () { state.panel = 'workflow'; state.decision = null; render(); }, { 'aria-pressed': state.panel === 'workflow' ? 'true' : 'false' }),
      tool(allFolded ? 'unfoldAll' : 'foldAll', allFolded ? 'Expand every step' : 'Minimize every step', function () {
        setCollapsed(workflowId, workflow.phases, !allFolded); render();
      }, { 'aria-pressed': allFolded ? 'true' : 'false' }),
      tool('wrap', state.wrap === false ? 'Wrap the steps into rows that fit the canvas' : 'Show the steps in one row', function () {
        state.wrap = state.wrap === false; view.fitted = false; render();
      }, { 'aria-pressed': state.wrap === false ? 'false' : 'true' }),
      tool('info', state.legend ? 'Hide the key' : 'Show the key: colours, shapes and how to move around', function () { state.legend = !state.legend; render(); }, { 'aria-pressed': state.legend ? 'true' : 'false' }));
  }

  function findBox(workflow, view, world) {
    var count = el('span', { class: 'muted', role: 'status' });
    function matches() {
      return workflow.phases.filter(function (phaseId) { var phase = state.draft.phases[phaseId] || { label: phaseId }; return findMatches(view, phase, state.draft.agents[phase.agent]); });
    }
    // Typing marks the matching steps in place; re-rendering would move the caret.
    function mark() {
      var found = matches();
      Array.prototype.forEach.call(world.querySelectorAll('.node'), function (node) { node.classList.toggle('match', found.indexOf(node.getAttribute('data-phase')) >= 0); });
      count.textContent = String(view.find || '').trim() ? found.length + (found.length === 1 ? ' step' : ' steps') : '';
    }
    function close() { view.finding = false; view.find = ''; render(); }
    var box = el('div', { class: 'find-box' }, icon('search', 14),
      el('input', { type: 'text', 'data-key': 'canvas-find', value: view.find || '', placeholder: 'Find a step or agent', 'aria-label': 'Find a step or agent',
        oninput: function (event) { view.find = event.target.value; mark(); },
        onkeydown: function (event) {
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          else if (event.key === 'Enter') { var found = matches(); if (found.length) { view.reveal = found[0]; selectStep(found[0]); } }
        } }),
      count,
      el('button', { type: 'button', class: 'secondary', onclick: close }, 'Close'));
    mark();
    return box;
  }

  function legend() {
    return el('div', { class: 'canvas-legend', role: 'note', 'aria-label': 'Key' },
      ['document', 'analysis', 'code', 'none'].map(function (output) { var look = OUTPUT_LOOK[output]; return el('span', { class: 'legend tone-' + look.tone }, el('span', { class: 'legend-dot' }), look.label); }),
      el('span', { class: 'legend tone-purple' }, el('span', { class: 'legend-dot diamond-dot' }), 'Decision'),
      el('span', { class: 'legend tone-orange' }, el('span', { class: 'legend-line' }), 'Send back'),
      el('span', { class: 'legend chip-action' }, icon('send', 11), 'Sends to an integration'),
      el('span', { class: 'legend' }, icon('up', 11), 'Minimize a step'),
      el('span', { class: 'legend hint-text', text: 'Drag the background to move · Ctrl or Cmd + wheel to zoom' }));
  }

  function renderCanvas(workflowId, workflow) {
    var view = canvasView(workflowId);
    var wrapWidth = state.wrap === false ? 0 : wrapWidthFor(view);
    var layout = canvasLayout(workflow, collapsedOf(workflowId), wrapWidth);
    var viewport = el('div', { class: 'canvas', role: 'region', 'aria-label': 'Steps of ' + workflow.label + '. Drag the background to move around; Ctrl or Cmd with the mouse wheel zooms.' });
    var world = el('div', { class: 'canvas-world' });
    world.style.cssText = 'width:' + layout.width + 'px;height:' + layout.height + 'px';
    world.appendChild(renderEdges(layout));
    layout.nodes.forEach(function (node) { world.appendChild(renderNode(workflowId, workflow, node, layout, view)); });
    var finish = el('div', { class: 'finish', title: 'The Story ends here' }, icon('flag', 14), 'Finish');
    finish.style.cssText = 'left:' + layout.finish.x + 'px;top:' + layout.finish.y + 'px;width:' + FINISH_W + 'px;height:36px';
    world.appendChild(finish);
    layout.edges.forEach(function (edge) {
      var shape = edgeGeometry(layout, edge);
      if (edge.kind === 'next') {
        if (!edge.decision) return;
        var decision = decisionById(workflow, edge.decision);
        var diamond = el('button', { type: 'button', class: 'diamond-node', title: decision.label, 'data-key': 'diamond-' + decision.id,
          'aria-label': 'Decision after ' + stepLabel(decision.after) + ': ' + decision.label, 'aria-pressed': state.decision === decision.id ? 'true' : 'false',
          onclick: function () { openDecision(decision); } });
        diamond.style.cssText = 'left:' + shape.x + 'px;top:' + shape.y + 'px';
        var caption = el('span', { class: 'diamond-caption', 'aria-hidden': 'true', text: decision.label });
        caption.style.cssText = 'left:' + shape.x + 'px;top:' + (shape.y + 18) + 'px';
        world.appendChild(diamond); world.appendChild(caption);
        return;
      }
      var label = el('button', { type: 'button', class: 'edge-label tone-' + shape.tone + (edge.stub ? ' stub' : ''), text: edge.stub ? edge.stubLabel : edge.label, title: edge.title || edge.stubLabel || edge.label, onclick: function () {
        if (edge.decision) { openDecision(decisionById(workflow, edge.decision)); return; }
        state.sections.signoff = true; state.focusKey = 'step-back'; selectStep(edge.step);
      } });
      label.style.cssText = 'left:' + shape.x + 'px;top:' + shape.y + 'px';
      world.appendChild(label);
    });
    viewport.appendChild(world);
    viewport.appendChild(renderToolRail(workflowId, workflow, view));
    var level = el('span', { class: 'zoom-level', text: Math.round(view.zoom * 100) + '%' });
    function apply() {
      world.style.transform = transformOf(view);
      var grid = 22 * view.zoom;
      while (grid < 12) grid *= 2;
      grid = Math.round(grid * 10) / 10;
      viewport.style.backgroundSize = grid + 'px ' + grid + 'px';
      viewport.style.backgroundPosition = Math.round(view.panX) + 'px ' + Math.round(view.panY) + 'px';
      level.textContent = Math.round(view.zoom * 100) + '%';
    }
    // However far it is moved, some of the workflow stays in sight.
    function clampPan() {
      var width = viewport.clientWidth || 800; var height = viewport.clientHeight || 400; var keep = 80;
      view.panX = Math.min(width - keep, Math.max(keep - layout.width * view.zoom, view.panX));
      view.panY = Math.min(height - keep, Math.max(keep - layout.height * view.zoom, view.panY));
    }
    function zoomAt(factor, cx, cy) {
      var next = Math.min(2, Math.max(0.25, Math.round(view.zoom * factor * 100) / 100));
      if (cx === undefined) { cx = (viewport.clientWidth || 800) / 2; cy = (viewport.clientHeight || 400) / 2; }
      view.panX = cx - (cx - view.panX) * next / view.zoom; view.panY = cy - (cy - view.panY) * next / view.zoom;
      view.zoom = next; clampPan(); apply();
    }
    // Fitting for reading keeps text legible and starts at the first step; fitting the whole shrinks it.
    function fit(readable) {
      var width = viewport.clientWidth; var height = viewport.clientHeight;
      if (!width || !height) return;
      var whole = Math.min(1, (width - 72) / layout.width, (height - 16) / layout.height);
      view.zoom = Math.max(readable ? 0.75 : 0.25, Math.round(whole * 100) / 100);
      view.panX = 56 + Math.max(0, (width - 72 - layout.width * view.zoom) / 2);
      view.panY = Math.max(0, (height - layout.height * view.zoom) / 2);
      apply();
    }
    function reveal(phaseId) {
      var node = layout.nodes.find(function (entry) { return entry.id === phaseId; });
      var width = viewport.clientWidth;
      if (!node || !width) return;
      var left = view.panX + node.x * view.zoom; var right = left + node.w * view.zoom;
      if (left < 60) view.panX += 60 - left;
      else if (right > width - 16) view.panX -= right - (width - 16);
      var height = viewport.clientHeight; var top = view.panY + node.y * view.zoom; var bottom = top + node.h * view.zoom;
      if (height && top < 12) view.panY += 12 - top;
      else if (height && bottom > height - 12) view.panY -= bottom - (height - 12);
      apply();
    }
    viewport.appendChild(el('div', { class: 'zoom-controls', role: 'toolbar', 'aria-label': 'Zoom' },
      el('button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: function () { zoomAt(1 / 1.2); } }, icon('minus', 14)),
      level,
      el('button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: function () { zoomAt(1.2); } }, icon('plus', 14)),
      el('button', { type: 'button', title: 'Fit the whole workflow', 'aria-label': 'Fit the whole workflow', onclick: function () { fit(false); } }, icon('fit', 14))));
    if (state.legend) viewport.appendChild(legend());
    if (view.finding) viewport.appendChild(findBox(workflow, view, world));
    var pan = null;
    viewport.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || event.target.closest('.node, .diamond-node, .edge-label, .zoom-controls, .tool-rail, .find-box, .canvas-legend')) return;
      pan = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY, moved: false };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('panning');
    });
    viewport.addEventListener('pointermove', function (event) {
      if (!pan) return;
      if (Math.abs(event.clientX - pan.x) + Math.abs(event.clientY - pan.y) > 3) pan.moved = true;
      view.panX = pan.panX + event.clientX - pan.x; view.panY = pan.panY + event.clientY - pan.y; clampPan(); apply();
    });
    function endPan(event) {
      if (!pan) return;
      var clicked = !pan.moved; pan = null; viewport.classList.remove('panning');
      // A click on the empty canvas shows the workflow's own settings, as clicking off a selection does.
      if (clicked && event.type === 'pointerup') { state.panel = 'workflow'; state.decision = null; render(); }
    }
    viewport.addEventListener('pointerup', endPan);
    viewport.addEventListener('pointercancel', endPan);
    viewport.addEventListener('wheel', function (event) {
      if (event.target.closest('.find-box')) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) { var box = viewport.getBoundingClientRect(); zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - box.left, event.clientY - box.top); return; }
      var dx = event.deltaX; var dy = event.deltaY;
      // A row of steps is wider than it is tall, so a plain wheel moves along it.
      if (event.shiftKey || (!dx && layout.height * view.zoom <= viewport.clientHeight)) { dx = dx || dy; dy = 0; }
      view.panX -= dx; view.panY -= dy; clampPan(); apply();
    }, { passive: false });
    apply();
    setTimeout(function () {
      if (!viewport.isConnected) return;
      // The rows were laid out for an estimated width; once the canvas is on screen, use its real one.
      var measured = viewport.clientWidth;
      if (wrapWidth && measured && Math.abs(measured - wrapWidth) > 48) { view.width = measured; view.fitted = false; render(); return; }
      if (measured) view.width = measured;
      if (!view.fitted) { view.fitted = true; fit(true); }
      if (view.reveal) { reveal(view.reveal); view.reveal = null; }
    }, 0);
    return viewport;
  }

  /** A collapsible inspector section, with an optional switch in its header and a summary shown when closed. */
  /** The reader a step's repository knowledge is written for: the engine's rules, applied to its ID. */
  function knowledgeReader(phaseId) {
    var id = String(phaseId || '').toLowerCase();
    var rules = ((state.model.choices.knowledge || {}).readers) || [];
    for (var i = 0; i < rules.length; i++) if (new RegExp(rules[i].pattern).test(id)) return rules[i].reader;
    return 'developer';
  }
  /** A step's World Model: the views ticked here, and the repository knowledge every step gets. */
  function worldModelSection(workflowId, phaseId, phase) {
    var choices = state.model.choices;
    var views = choices.views || [];
    var knowledge = choices.knowledge || { prompt: 'slice', maxBytes: 8192 };
    var workflow = (state.model.workflows || []).find(function (entry) { return entry.id === workflowId; });
    var off = Boolean(workflow && workflow.worldModel === 'off');
    var retired = choices.retiredViews || [];
    var body = [];
    if (off) body.push(el('p', { class: 'hint', text: 'This workflow turns the World Model off: its steps get no views and no repository knowledge.' }));
    body.push(views.length
      ? el('div', { class: 'checks' }, views.map(function (view) {
        return el('label', null, el('input', { type: 'checkbox', 'data-key': 'view-' + view, checked: phase.views.indexOf(view) >= 0, onchange: function (event) {
          phase.views = event.target.checked ? phase.views.concat([view]) : phase.views.filter(function (entry) { return entry !== view; }); changed();
        } }), view);
      }))
      : el('p', { class: 'hint', text: 'This repository has no World Model views to choose from.' }));
    body.push(el('p', { class: 'hint', 'data-key': 'world-model-knowledge', text: knowledge.prompt === 'off'
      ? 'Repository knowledge is off for this repository (worldModel.knowledge.prompt: off).'
      : 'Repository knowledge (rules, flows, tests and risks read from the committed code) is added to this step\'s prompt for the ' + knowledgeReader(phaseId) + ' reader, up to ' + Math.round(knowledge.maxBytes / 1024) + ' KB. Nothing to set here.' }));
    if (retired.length) body.push(el('p', { class: 'hint', 'data-key': 'world-model-retired', text: 'workflow.yml still names retired views (' + retired.join(', ') + '). They are ignored; run singularity-flow wm migrate-views to replace them.' }));
    var summary = off ? 'off in this workflow'
      : (phase.views.length ? phase.views.length + ' view' + (phase.views.length === 1 ? '' : 's') : 'no views') + (knowledge.prompt === 'off' ? '' : ' + repository knowledge');
    return section('views', 'World Model', body, null, summary, !phase.isNew);
  }
  function section(key, title, body, control, summary, closed) {
    var open = state.sections[key] === undefined ? !closed : state.sections[key];
    return el('section', { class: 'prop-section' },
      el('div', { class: 'section-head' },
        el('button', { type: 'button', class: 'section-toggle', 'aria-expanded': open ? 'true' : 'false', 'data-key': 'section-' + key, onclick: function () { state.sections[key] = !open; render(); } },
          el('span', { class: 'chevron', 'aria-hidden': 'true', text: open ? '▾' : '▸' }), title,
          !open && summary ? el('span', { class: 'summary', text: '· ' + summary }) : null),
        control || null),
      open ? el('div', { class: 'prop-body' }, body) : null);
  }
  function switchControl(key, label, on, onChange) {
    return el('label', { class: 'switch', title: label },
      el('input', { type: 'checkbox', role: 'switch', 'data-key': key, checked: on, 'aria-checked': on ? 'true' : 'false', 'aria-label': label, onchange: function (event) { onChange(event.target.checked); } }),
      el('span', { class: 'slider', 'aria-hidden': 'true' }));
  }
  /** The panel's title, with the actions for what it shows and the control that hides the panel. */
  function propTitle(tone, iconName, eyebrow, title, tools) {
    return el('div', { class: 'prop-title' }, el('span', { class: 'node-icon tone-' + tone }, icon(iconName, 18)),
      el('div', null, el('div', { class: 'lane-label', text: eyebrow }), el('h2', { text: title, title: title })),
      el('div', { class: 'prop-tools' }, tools || null,
        el('button', { type: 'button', class: 'prop-icon', 'data-key': 'panel-hide', title: 'Hide the properties panel', 'aria-label': 'Hide the properties panel',
          onclick: function () { state.panelHidden = true; state.focusKey = 'panel-show'; rewrap(); } }, icon('panel', 15))));
  }
  function propTool(name, label, onClick, attrs) {
    return el('button', Object.assign({ type: 'button', class: 'prop-icon', title: label, 'aria-label': label, onclick: onClick }, attrs || {}), icon(name, 14));
  }

  // The board fills the window without making the page scroll, because the canvas owns the wheel.
  // The page shell's own header and footer vary, so the spare height is measured, not assumed.
  function fitBoard() {
    var board = document.querySelector('.board');
    if (!board) return;
    board.style.height = '';
    if (window.innerWidth <= 900) return;
    var spare = document.documentElement.scrollHeight - window.innerHeight;
    board.style.height = Math.floor(Math.max(420, board.getBoundingClientRect().height - spare)) + 'px';
  }

  function renderBoard(main) {
    var workflowId = state.workflow;
    var workflow = state.draft.workflows[workflowId];
    if (!workflow) { state.view = 'home'; render(); return; }
    if (workflowReadOnly(workflowId)) { renderSeededWorkflow(main, workflow, 'story'); return; }
    var phases = workflow.phases;
    if (phases.indexOf(state.step) < 0) state.step = phases[0];
    main.appendChild(el('div', { class: 'board-head' },
      el('div', { class: 'studio-row' },
        el('button', { type: 'button', class: 'crumb', onclick: function () { state.view = 'home'; render(); } }, 'Workflows'),
        el('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '›' }),
        select('board-workflow', Object.keys(state.draft.workflows).map(function (id) { return { value: id, label: state.draft.workflows[id].label }; }), workflowId, function (value) {
          openWorkflowCanvas(value);
        }, { 'aria-label': 'Workflow' }),
        workflow.isNew || workflow.installFrom ? el('span', { class: 'pill new', text: 'New · not published' }) : null,
        el('span', { class: 'muted', text: phases.length + (phases.length === 1 ? ' step' : ' steps') + (workflow.description ? ' · ' + workflow.description : '') }),
        workflow.isNew || workflow.installFrom ? button('Back to details', function () { openWorkflowDetails(workflowId); }, { class: 'secondary', 'data-key': 'workflow-details' }) : null,
        workflow.isNew || workflow.installFrom ? button('Cancel this workflow', function () { askRemoveNewWorkflow(workflowId); }, { class: 'secondary', 'data-key': 'workflow-cancel' }) : null),
      el('div', { id: 'studio-status', class: 'studio-status muted', role: 'status', 'aria-live': 'polite', text: state.status }),
      button('Review changes (' + changesNow().length + ')', function () { state.view = 'changes'; render(); }, { class: 'primary' })));
    var selectedDecision = state.decision ? decisionById(workflow, state.decision) : null;
    if (!selectedDecision) state.decision = null;
    var inspector = state.panel === 'add' ? renderAddStep(workflowId, workflow)
      : state.panel === 'workflow' ? renderWorkflowProperties(workflowId, workflow)
        : selectedDecision ? renderDecisionInspector(workflowId, selectedDecision) : renderInspector(workflowId, state.step);
    var board = el('div', { class: 'board' + (state.panelHidden ? ' panel-hidden' : '') });
    board.style.setProperty('--panel-w', Math.round(state.panelWidth || 380) + 'px');
    board.appendChild(renderCanvas(workflowId, workflow));
    board.appendChild(splitter(board));
    board.appendChild(state.panelHidden ? el('aside', { class: 'panel-strip', 'aria-label': 'Properties panel, hidden' },
      el('button', { type: 'button', class: 'prop-icon', 'data-key': 'panel-show', title: 'Show the properties panel', 'aria-label': 'Show the properties panel',
        onclick: function () { state.panelHidden = false; state.focusKey = 'panel-hide'; rewrap(); } }, icon('panel', 15)),
      el('span', { class: 'strip-label', 'aria-hidden': 'true', text: 'PROPERTIES' })) : inspector);
    main.appendChild(board);
  }

  /** A new canvas width wraps the rows again. */
  function rewrap() { var view = state.workflow ? canvasView(state.workflow) : null; if (view) { view.width = 0; view.fitted = false; } render(); }

  /** The handle between the canvas and the panel: drag it, or use the arrow keys, to resize the panel. */
  function splitter(board) {
    function setWidth(width) {
      var room = Math.max(PANEL_MIN, (board.clientWidth || 1200) - 360);
      state.panelWidth = Math.round(Math.min(PANEL_MAX, room, Math.max(PANEL_MIN, width)));
      board.style.setProperty('--panel-w', state.panelWidth + 'px');
    }
    var drag = null;
    var handle = el('div', { class: 'splitter', role: 'separator', tabindex: '0', 'data-key': 'panel-splitter', 'aria-orientation': 'vertical',
      'aria-label': 'Resize the properties panel', 'aria-valuemin': String(PANEL_MIN), 'aria-valuemax': String(PANEL_MAX), 'aria-valuenow': String(Math.round(state.panelWidth || 380)),
      onpointerdown: function (event) {
        if (state.panelHidden || event.button !== 0) return;
        drag = { x: event.clientX, width: state.panelWidth || 380 }; handle.setPointerCapture(event.pointerId); handle.classList.add('dragging');
      },
      onpointermove: function (event) { if (drag) setWidth(drag.width + drag.x - event.clientX); },
      onpointerup: function () { if (!drag) return; drag = null; handle.classList.remove('dragging'); rewrap(); },
      onkeydown: function (event) {
        if (state.panelHidden) return;
        var step = event.shiftKey ? 64 : 24;
        if (event.key === 'ArrowLeft') setWidth((state.panelWidth || 380) + step);
        else if (event.key === 'ArrowRight') setWidth((state.panelWidth || 380) - step);
        else return;
        event.preventDefault(); state.focusKey = 'panel-splitter'; rewrap();
      } });
    return handle;
  }

  function renderAddStep(workflowId, workflow) {
    var phases = workflow.phases;
    var library = Object.keys(state.draft.phases).filter(function (id) { return phases.indexOf(id) < 0; }).sort(function (a, b) { return state.draft.phases[a].label.localeCompare(state.draft.phases[b].label); });
    var adding = state.adding || (state.adding = { phase: library[0] || '', label: '', output: 'document', agent: '', after: null });
    if (library.indexOf(adding.phase) < 0) adding.phase = library[0] || '';
    if (phases.indexOf(adding.after) < 0) adding.after = phases.indexOf(state.step) >= 0 ? state.step : phases[phases.length - 1];
    var aside = el('aside', { class: 'inspector properties', 'aria-label': 'Add a step' });
    aside.appendChild(propTitle('blue', 'plus', 'NEW STEP', 'Add a step'));
    aside.appendChild(section('add-where', 'Where', field('add-after', 'After', select('add-after', phases.map(function (id) { return { value: id, label: stepLabel(id) }; }), adding.after, function (value) { adding.after = value; }))));
    if (library.length) {
      aside.appendChild(section('add-existing', 'From the step catalog', [
        field('add-existing', 'Step', select('add-existing', library.map(function (id) { var phase = state.draft.phases[id]; var agent = state.draft.agents[phase.agent]; return { value: id, label: phase.label + (agent ? ' · ' + agent.label : '') }; }), adding.phase, function (value) { adding.phase = value; })),
        el('div', { class: 'studio-row' }, button('Add this step', function () { var id = adding.phase; state.panel = null; addExistingStep(workflowId, id, adding.after); }, { class: 'primary' }))
      ]));
    }
    aside.appendChild(section('add-new', 'A new step', [
      field('add-new-name', 'Name', textInput('add-new-name', adding.label, function (value) { adding.label = value; }, { placeholder: 'Vendor analysis' })),
      field('add-new-output', 'Produces', select('add-new-output', (state.model.choices.outputs || []).map(function (output) { return { value: output.id, label: output.label }; }), adding.output, function (value) { adding.output = value; })),
      field('add-new-agent', 'Drafted by', select('add-new-agent', agentOptions(adding.agent), adding.agent, function (value) { if (value === '__new__') { openAgentForm({ returnTo: 'board-add' }); return; } adding.agent = value; requestRender(); })),
      el('p', { class: 'hint', 'data-key': 'add-new-world-model', text: newStepWorldModelHint(adding.agent, adding.label) }),
      el('div', { class: 'studio-row' }, button('Create step', function () {
        if (!adding.agent) { setStatus('Choose the agent that drafts the new step.'); return; }
        if (createStep(workflowId, adding.label.trim(), adding.output, adding.agent, adding.after)) { adding.label = ''; state.panel = null; }
      }, { class: 'primary' }))
    ]));
    aside.appendChild(el('div', { class: 'prop-actions' }, button('Cancel', function () { state.adding = null; state.panel = null; render(); }, { class: 'secondary' })));
    return aside;
  }

  function renderWorkflowProperties(workflowId, workflow) {
    var aside = el('aside', { class: 'inspector properties', 'aria-label': 'Workflow settings' });
    aside.appendChild(propTitle('blue', 'flow', 'WORKFLOW', workflow.label));
    aside.appendChild(section('workflow', 'Workflow', [
      field('board-label', 'Name', textInput('board-label', workflow.label, function (value) { if (value.trim()) { workflow.label = value.trim(); changed(); } })),
      field('board-description', 'What it is for', textInput('board-description', workflow.description, function (value) { workflow.description = value.trim(); changed(); })),
      el('span', { class: 'hint', text: workflow.phases.length + (workflow.phases.length === 1 ? ' step' : ' steps') + (workflow.isNew || workflow.installFrom ? ' · new, not published yet' : '') })
    ]));
    var loops = workflow.reworkLoops || [];
    aside.appendChild(section('rules', 'Send-back rules', loops.length ? loops.map(function (loop) {
      return el('button', { type: 'button', class: 'prop-link', onclick: function () { state.sections.signoff = true; selectStep(loop.from); } }, 'If ' + stepLabel(loop.from) + ' is rejected, back to ' + stepLabel(loop.to) + ', at most ' + loop.maxAttempts + (loop.maxAttempts === 1 ? ' time' : ' times'));
    }) : el('span', { class: 'hint', text: 'None yet. Select a step people sign off and choose where rejected work goes back to.' }), null, String(loops.length)));
    var decisions = workflow.decisions || [];
    aside.appendChild(section('decisions', 'Decisions', decisions.length ? decisions.map(function (decision) {
      return el('button', { type: 'button', class: 'prop-link', onclick: function () { openDecision(decision); } }, 'After ' + stepLabel(decision.after) + ': ' + decision.label);
    }) : el('span', { class: 'hint', text: 'None yet. Select a step and use the diamond tool to decide what happens after it.' }), null, String(decisions.length)));
    var claimsSection = plannedClaimsSection(workflowId, workflow);
    if (claimsSection) aside.appendChild(claimsSection);
    aside.appendChild(section('advanced', 'Advanced', [
      el('span', { class: 'hint', text: 'Settings Studio does not show (input selectors and summaries, write scope, tool evidence) are in the governed workflow file.' }),
      el('div', { class: 'studio-row' }, button('Open workflow.yml', function () { openFile('singularity/workflow.yml'); }, { class: 'secondary' }))
    ], null, null, true));
    aside.appendChild(el('div', { class: 'prop-actions' }, button('Back to the step', function () { state.panel = null; render(); }, { class: 'secondary' })));
    return aside;
  }

  // ---- Planned claims ------------------------------------------------------------------------
  //
  // A code step implements claims an earlier step planned, against clauses a requirements or
  // implementation-spec step defined. Left alone, the engine works the topology out from the steps
  // and pins it; here a person can name the clause steps and each code step's owner instead.

  function claimsOf(workflowId) {
    var published = (state.model.workflows || []).find(function (entry) { return entry.id === workflowId; });
    return published && published.plannedClaims ? published.plannedClaims : null;
  }
  function editableClaims(workflowId, workflow) {
    if (workflow.plannedClaims && workflow.plannedClaims.clausePhases && workflow.plannedClaims.owners) return workflow.plannedClaims;
    var resolved = claimsOf(workflowId) || { clausePhases: [], owners: {} };
    workflow.plannedClaims = { mode: 'required', clausePhases: resolved.clausePhases.filter(function (id) { return workflow.phases.indexOf(id) >= 0; }), owners: clone(resolved.owners || {}) };
    return workflow.plannedClaims;
  }
  function plannedClaimsSection(workflowId, workflow) {
    var codeSteps = workflow.phases.filter(function (id) { return stepOutput(workflowId, id) === 'code'; });
    if (!codeSteps.length) return null;
    var resolved = claimsOf(workflowId);
    var clauseSteps = workflow.phases.filter(function (id) { var step = state.draft.steps[workflowId] && state.draft.steps[workflowId][id]; return Boolean(step && step.definesClauses); });
    var declared = workflow.plannedClaims;
    var current = declared && declared.clausePhases && declared.owners ? declared : resolved ? { clausePhases: resolved.clausePhases, owners: resolved.owners } : { clausePhases: [], owners: {} };
    var body = [];
    body.push(el('span', { class: 'hint', text: declared ? 'This workflow names its clause steps and claim owners.' : 'Worked out from the steps; edit them to name them yourself.' }));
    if (resolved && resolved.problem) body.push(el('div', { class: 'callout bad', text: resolved.problem }));
    body.push(el('span', { class: 'lane-label', text: 'STEPS THAT DEFINE CLAUSES' }));
    body.push(clauseSteps.length ? el('div', { class: 'checks' }, clauseSteps.map(function (id) {
      return el('label', null, el('input', { type: 'checkbox', 'data-key': 'claims-clause-' + id, checked: current.clausePhases.indexOf(id) >= 0, onchange: function (event) {
        var claims = editableClaims(workflowId, workflow);
        claims.clausePhases = event.target.checked ? claims.clausePhases.concat([id]) : claims.clausePhases.filter(function (entry) { return entry !== id; });
        claims.clausePhases.sort(function (a, b) { return workflow.phases.indexOf(a) - workflow.phases.indexOf(b); });
        changed();
      } }), ' ' + stepLabel(id));
    })) : el('div', { class: 'callout wait', text: 'No step in this workflow writes a requirements or implementation-spec document, so code steps have no clauses to plan against.' }));
    body.push(el('span', { class: 'lane-label', text: 'WHO PLANS THE CLAIMS OF EACH CODE STEP' }));
    codeSteps.forEach(function (codeId) {
      var before = workflow.phases.slice(0, workflow.phases.indexOf(codeId)).filter(function (id) { return stepOutput(workflowId, id) !== 'code'; });
      var owner = current.owners[codeId] || '';
      body.push(field('claims-owner-' + codeId, stepLabel(codeId), select('claims-owner-' + codeId, [{ value: '', label: 'Choose…' }].concat(before.map(function (id) { return { value: id, label: stepLabel(id) }; })), owner, function (value) {
        var claims = editableClaims(workflowId, workflow);
        if (value) claims.owners[codeId] = value; else delete claims.owners[codeId];
        changed();
      }), 'An earlier step, at or after a step that defines clauses.'));
    });
    body.push(el('div', { class: 'studio-row' }, button('Work them out from the steps', function () { workflow.plannedClaims = null; changed(); }, { class: 'secondary', disabled: !declared })));
    var summary = (current.clausePhases.length ? current.clausePhases.map(stepLabel).join(', ') : 'no clause steps') + (declared ? '' : ' · worked out');
    return section('claims', 'Planned claims', body, null, summary, true);
  }

  /** The other workflows in the draft that use a step. */
  function otherUsers(workflowId, phaseId) {
    return Object.keys(state.draft.workflows).filter(function (id) { return id !== workflowId && state.draft.workflows[id].phases.indexOf(phaseId) >= 0; });
  }

  /**
   * Which skill drafts a step in this workflow, as Drafted with offers it: nothing for a sign-off-only
   * step; a fixed line where the engine refuses a choice, for a step only its deterministic generator
   * produces and for a compiled skill step, whose binding decides; otherwise Automatic, which follows
   * what the step produces, and every skill that can draft that output, each with its description.
   * On a shared step the choice is this workflow's own, as sign-off is.
   */
  function skillPicker(workflowId, phaseId, settings, users) {
    var output = stepOutput(workflowId, phaseId);
    if (output === 'none') return null;
    // How this workflow runs the step, where its settings say; otherwise how the step itself is.
    // Convergence is known by its artifact kind, which the engine reports, never by the step's name.
    var route = settings.generatedByEngine !== undefined ? settings : state.draft.phases[phaseId] || {};
    if (route.generatedByEngine || route.convergence) {
      return route.convergence
        ? { fixed: '/sf-converge', hint: 'Deterministic convergence always uses /sf-converge.' }
        : { fixed: 'Generated by the engine', hint: 'Only the engine\'s deterministic generator produces this step, so no drafting skill can be chosen.' };
    }
    if (route.compiledSkill) return { fixed: 'Its compiled skill', hint: 'This step\'s compiled skill binding decides how it is drafted, so no drafting skill can be chosen.' };
    var automatic = output === 'code' ? '/sf-code' : '/sf-phase';
    var catalog = state.model.choices.authoringSkills || [];
    var automaticChoice = catalog.find(function (choice) { return choice.label === automatic; });
    var choices = catalog.filter(function (choice) { return choice.produces.indexOf(output) >= 0 && choice.label !== automatic; });
    var current = settings.authoringSkill || '';
    var options = [{ value: '', label: 'Automatic (' + automatic + ')', title: automaticChoice && automaticChoice.description || null }]
      .concat(choices.map(function (choice) { return { value: choice.id, label: choice.label, title: choice.description || null }; }));
    if (current && !options.some(function (option) { return option.value === current; })) options.push({ value: current, label: '/' + current });
    var chosen = choices.find(function (choice) { return choice.id === current; });
    var hint = chosen && chosen.description ? chosen.description : current ? 'Drafted with /' + current + '.' : 'Chosen by what the step produces.';
    // A specialised skill also takes its built-in step by that step's name, never a copy of it.
    var copyOf = (state.draft.phases[phaseId] || {}).copyOf;
    var byName = !current && copyOf && automatic === '/sf-phase'
      ? catalog.find(function (choice) { return (choice.legacyPhases || []).indexOf(copyOf) >= 0 && choice.produces.indexOf(output) >= 0; }) : null;
    if (byName) hint += ' ' + byName.label + ' takes ' + stepLabel(copyOf) + ' by its name, but not this copy: choose it here to draft the copy with it.';
    if (settings.authoringSkillSetByWorkflow) hint = 'Set by this workflow. ' + hint;
    else if (users.length) hint += ' Only this workflow changes; ' + users.map(function (id) { return state.draft.workflows[id].label; }).join(', ') + (users.length === 1 ? ' keeps its own.' : ' keep their own.');
    return { options: options, value: current, hint: hint };
  }

  /** A drafting skill picked for a step in one workflow; a skill an output change set aside is forgotten. */
  function chooseAuthoringSkill(workflowId, phaseId, value) {
    var settings = stepSettings(workflowId, phaseId);
    settings.authoringSkill = value || null;
    delete settings.setAsideSkill;
    // The engine records a shared or already overridden step's choice as this workflow's own.
    if (otherUsers(workflowId, phaseId).length || settings.authoringSkillSetByWorkflow) settings.authoringSkillSetByWorkflow = true;
    changed();
  }

  function authoringSkillControl(workflowId, phaseId, settings, users) {
    var picker = skillPicker(workflowId, phaseId, settings, users);
    if (!picker) return null;
    if (picker.fixed) return field('step-skill', 'Drafted with', el('span', { class: 'pill', id: 'step-skill', text: picker.fixed }), picker.hint);
    return field('step-skill', 'Drafted with', select('step-skill', picker.options, picker.value, function (value) { chooseAuthoringSkill(workflowId, phaseId, value); }), picker.hint);
  }

  /**
   * After a step's output changes, a chosen skill that cannot draft it goes back to automatic: the
   * step's own, which the engine drops with the output change, and each workflow's. A skill reset
   * here is set aside, not forgotten, so changing the output back before publishing restores it
   * instead of leaving a reset in the change set.
   */
  function resetIncompatibleSkills(phaseId) {
    var reset = []; var restored = [];
    function canDraft(skill, output) {
      var choice = (state.model.choices.authoringSkills || []).find(function (entry) { return entry.id === skill; });
      return Boolean(choice && choice.produces.indexOf(output) >= 0);
    }
    function settle(holder, output) {
      if (holder.authoringSkill && !canDraft(holder.authoringSkill, output)) {
        if (reset.indexOf('/' + holder.authoringSkill) < 0) reset.push('/' + holder.authoringSkill);
        holder.setAsideSkill = holder.authoringSkill;
        holder.authoringSkill = null;
      } else if (!holder.authoringSkill && holder.setAsideSkill && canDraft(holder.setAsideSkill, output)) {
        if (restored.indexOf('/' + holder.setAsideSkill) < 0) restored.push('/' + holder.setAsideSkill);
        holder.authoringSkill = holder.setAsideSkill;
        delete holder.setAsideSkill;
      }
    }
    var phase = state.draft.phases[phaseId];
    if (phase) settle(phase, phase.output);
    Object.keys(state.draft.workflows).forEach(function (workflowId) {
      if (state.draft.workflows[workflowId].phases.indexOf(phaseId) < 0) return;
      var settings = state.draft.steps[workflowId] && state.draft.steps[workflowId][phaseId];
      if (settings) settle(settings, stepOutput(workflowId, phaseId));
    });
    var words = [];
    if (reset.length) words.push('Drafted with is automatic again: ' + reset.join(', ') + ' cannot draft what this step now produces.');
    if (restored.length) words.push('Drafted with is ' + restored.join(', ') + ' again.');
    if (words.length) setStatus(words.join(' '));
  }

  /** What a step itself produces, chosen in the inspector; drafting skills follow (resetIncompatibleSkills). */
  function setStepOutput(phaseId, output) {
    state.draft.phases[phaseId].output = output;
    resetIncompatibleSkills(phaseId);
    changed();
  }

  // ---- Sign-off groups -------------------------------------------------------------------------
  //
  // A step can be signed off by several approval groups: approvals from any of them count towards
  // the number needed, and a group marked "must approve" has to give at least one of them.

  function setApprovalGroups(approval, groups) {
    approval.groups = groups.slice(); approval.group = groups[0] || null;
    approval.required = (approval.required || []).filter(function (id) { return groups.indexOf(id) >= 0; });
    if ((approval.minimum || 1) < approval.required.length) approval.minimum = approval.required.length;
  }
  function approvalGroupsEditor(settings) {
    var approval = settings.approval;
    var signers = groupsOf(approval);
    var required = approval.required || (approval.required = []);
    var box = el('div', { class: 'field', role: 'group', 'aria-label': 'Approval groups' }, el('span', { class: 'lane-label', text: 'APPROVAL GROUPS' }));
    box.appendChild(el('div', { class: 'checks' }, Object.keys(state.draft.groups).map(function (id) {
      var group = state.draft.groups[id]; var chosen = signers.indexOf(id) >= 0;
      return el('div', { class: 'studio-row spread' },
        el('label', null, el('input', { type: 'checkbox', 'data-key': 'step-group-' + id, checked: chosen, disabled: chosen && signers.length === 1, onchange: function (event) {
          setApprovalGroups(approval, event.target.checked ? signers.concat([id]) : signers.filter(function (entry) { return entry !== id; })); changed();
        } }), ' ' + group.label, el('span', { class: 'muted', text: ' · ' + groupHint(group) })),
        chosen && signers.length > 1 ? el('label', { class: 'muted' }, el('input', { type: 'checkbox', 'data-key': 'step-group-required-' + id, 'aria-label': group.label + ' must approve', checked: required.indexOf(id) >= 0, onchange: function (event) {
          approval.required = event.target.checked ? required.concat([id]) : required.filter(function (entry) { return entry !== id; });
          if ((approval.minimum || 1) < approval.required.length) approval.minimum = approval.required.length;
          changed();
        } }), ' must approve') : null);
    })));
    box.appendChild(el('span', { class: 'hint', text: signers.length > 1 ? 'Approvals from any of these groups count; a group that must approve has to give at least one.' : 'Add another group to let its people approve too.' }));
    return box;
  }

  // ---- Send-back rules ------------------------------------------------------------------------
  //
  // A step's rules each name an earlier step rejected work goes back to, how many times at most, and
  // optionally a step whose next run starts the count again. Rules into the same step share its
  // repair budget, so changing one changes all of them, as the engine requires.

  function loopBudget(workflow, to) {
    var into = workflow.reworkLoops.find(function (entry) { return entry.to === to; });
    return into ? { maxAttempts: into.maxAttempts, resetOnPhase: into.resetOnPhase || null } : null;
  }
  function setLoopBudget(workflow, to, maxAttempts, resetOnPhase) {
    workflow.reworkLoops.forEach(function (entry) {
      if (entry.to !== to) return;
      entry.maxAttempts = maxAttempts;
      if (resetOnPhase) entry.resetOnPhase = resetOnPhase; else delete entry.resetOnPhase;
    });
  }
  function ruleWithBudget(workflow, from, to, fallback) {
    var budget = loopBudget(workflow, to) || fallback || { maxAttempts: 3, resetOnPhase: null };
    var reset = budget.resetOnPhase && workflow.phases.indexOf(budget.resetOnPhase) >= 0 && workflow.phases.indexOf(budget.resetOnPhase) < workflow.phases.indexOf(to) ? budget.resetOnPhase : null;
    var rule = { from: from, to: to, maxAttempts: budget.maxAttempts };
    if (reset) rule.resetOnPhase = reset;
    return rule;
  }
  function addSendBack(workflow, phaseId, earlier) {
    var taken = workflow.reworkLoops.filter(function (entry) { return entry.from === phaseId; }).map(function (entry) { return entry.to; });
    var target = earlier.slice().reverse().find(function (id) { return taken.indexOf(id) < 0; });
    if (!target) return false;
    workflow.reworkLoops.push(ruleWithBudget(workflow, phaseId, target));
    return true;
  }
  function retargetSendBack(workflow, rule, to) {
    var index = workflow.reworkLoops.indexOf(rule);
    if (index < 0 || rule.to === to) return;
    var others = workflow.reworkLoops.filter(function (entry) { return entry !== rule; });
    var replaced = ruleWithBudget({ phases: workflow.phases, reworkLoops: others }, rule.from, to, { maxAttempts: rule.maxAttempts, resetOnPhase: rule.resetOnPhase || null });
    workflow.reworkLoops.splice(index, 1, replaced);
  }
  function sendBackEditor(workflow, phaseId, earlier) {
    var rules = workflow.reworkLoops.filter(function (entry) { return entry.from === phaseId; });
    var box = el('div', { class: 'field', role: 'group', 'aria-label': 'If rejected, send back to' }, el('span', { class: 'lane-label', text: 'IF REJECTED, SEND BACK TO' }));
    if (!earlier.length) { box.appendChild(el('span', { class: 'hint', text: 'The first step has no earlier step to send work back to; rejected work is redone here.' })); return box; }
    if (!rules.length) box.appendChild(el('span', { class: 'hint', text: 'Rejected work is redone in this step. Add a rule to let approvers send it back to an earlier step.' }));
    rules.forEach(function (rule, index) {
      var targets = earlier.filter(function (id) { return id === rule.to || !rules.some(function (other) { return other !== rule && other.to === id; }); });
      var resets = workflow.phases.slice(0, workflow.phases.indexOf(rule.to));
      var sharing = workflow.reworkLoops.filter(function (other) { return other !== rule && other.to === rule.to; }).map(function (other) { return stepLabel(other.from); });
      box.appendChild(el('div', { class: 'decision-box', 'aria-label': 'Send-back rule ' + (index + 1) },
        el('div', { class: 'studio-row', style: 'flex-wrap:nowrap' },
          select('step-back-' + index, targets.map(function (id) { return { value: id, label: stepLabel(id) }; }), rule.to, function (value) { retargetSendBack(workflow, rule, value); changed(); }, { 'aria-label': 'Send back to', style: 'flex:1;min-width:0' }),
          button('Remove', function () { workflow.reworkLoops = workflow.reworkLoops.filter(function (entry) { return entry !== rule; }); changed(); }, { class: 'secondary', 'aria-label': 'Remove the send-back to ' + stepLabel(rule.to) })),
        el('div', { class: 'grid-2' },
          field('step-back-max-' + index, 'At most', el('input', { type: 'text', inputmode: 'numeric', id: 'step-back-max-' + index, 'data-key': 'step-back-max-' + index, value: String(rule.maxAttempts),
            onchange: function (event) {
              var count = /^\s*\d+\s*$/.test(event.target.value) ? Number(event.target.value) : NaN;
              if (!Number.isInteger(count) || count < 1 || count > 100) { setStatus('A step can be sent back 1 to 100 times.'); render(); return; }
              setLoopBudget(workflow, rule.to, count, rule.resetOnPhase || null); changed();
            } }), 'times (1 to 100)'),
          field('step-back-reset-' + index, 'Count again after', select('step-back-reset-' + index, [{ value: '', label: 'Never' }].concat(resets.map(function (id) { return { value: id, label: stepLabel(id) + ' runs again' }; })), rule.resetOnPhase || '', function (value) {
            setLoopBudget(workflow, rule.to, rule.maxAttempts, value || null); changed();
          }))),
        sharing.length ? el('span', { class: 'hint', text: 'Shares its count with the send-back from ' + sharing.join(', ') + ' into ' + stepLabel(rule.to) + '.' }) : null));
    });
    var free = earlier.some(function (id) { return !rules.some(function (rule) { return rule.to === id; }); });
    box.appendChild(el('div', { class: 'studio-row' },
      button('Add a send-back rule', function () { if (addSendBack(workflow, phaseId, earlier)) changed(); }, { class: 'secondary', disabled: !free }),
      rules.length ? el('span', { class: 'hint', text: 'Sending work back repeats the steps in between; approvers choose which rule to use.' }) : null));
    return box;
  }

  function renderInspector(workflowId, phaseId) {
    var workflow = state.draft.workflows[workflowId];
    var phase = state.draft.phases[phaseId];
    var aside = el('aside', { class: 'inspector properties', 'aria-label': 'Step properties' });
    if (!phase) { aside.appendChild(el('p', { class: 'muted', text: 'Select a step.' })); return aside; }
    var index = workflow.phases.indexOf(phaseId);
    var settings = stepSettings(workflowId, phaseId);
    var users = Object.keys(state.draft.workflows).filter(function (id) { return state.draft.workflows[id].phases.indexOf(phaseId) >= 0 && id !== workflowId; });
    var agent = state.draft.agents[phase.agent];
    var look = OUTPUT_LOOK[stepOutput(workflowId, phaseId)] || OUTPUT_LOOK.document;
    aside.appendChild(propTitle(look.tone, look.icon, 'STEP ' + (index + 1) + ' OF ' + workflow.phases.length, phase.label, [
      propTool('left', 'Move earlier', function () { moveStep(workflowId, phaseId, -1); }, { disabled: index === 0 }),
      propTool('right', 'Move later', function () { moveStep(workflowId, phaseId, 1); }, { disabled: index === workflow.phases.length - 1 }),
      propTool('trash', 'Remove from workflow', function () { removeStep(workflowId, phaseId); })]));

    var ownOutput = outputSetByWorkflow(settings, phase);
    aside.appendChild(section('step', 'Step', [
      field('step-name', 'Name', textInput('step-name', phase.label, function (value) { if (value.trim()) { phase.label = value.trim(); changed(); } }), users.length ? 'Renames it in ' + users.map(function (id) { return state.draft.workflows[id].label; }).join(', ') + ' too.' : null),
      field('step-output', 'Produces', select('step-output', (state.model.choices.outputs || []).map(function (output) { return { value: output.id, label: output.label }; }), stepOutput(workflowId, phaseId), function (value) { setStepOutput(phaseId, value); }, { disabled: ownOutput }),
        ownOutput ? 'This workflow sets what this step produces itself, in its own settings in workflow.yml (Advanced, in the workflow settings).'
          : stepOutput(workflowId, phaseId) === 'code' ? 'A code step needs a requirements or implementation-spec step before it; the check says so if one is missing.' : null),
      authoringSkillControl(workflowId, phaseId, settings, users),
      users.length && !phase.isNew ? el('div', { class: 'callout wait' },
        el('div', { text: phase.label + ' is also used by ' + users.map(function (id) { return state.draft.workflows[id].label; }).join(', ') + '. Its agent, name and output change there too.' }),
        button('Use a copy in this workflow', function () { copyStepForWorkflow(workflowId, phaseId); }, { class: 'secondary', style: 'margin-top:6px' })) : null
    ], null, look.label));

    aside.appendChild(section('agent', 'Drafting agent', [
      el('div', { class: 'agent-row' }, el('span', { class: 'avatar large', 'aria-hidden': 'true', text: agent ? initials(agent.label) : '?' }),
        el('div', null, el('strong', { text: agent ? agent.label : 'No agent yet' }), el('div', { class: 'muted', text: agent ? agent.description : 'Every step needs exactly one agent.' }))),
      field('step-agent', 'Drafted by', select('step-agent', agentOptions(phase.agent), phase.agent || '', function (value) {
        if (value === '__new__') { openAgentForm({ returnTo: 'step', phase: phaseId }); return; }
        phase.agent = value; changed();
      })),
      agent && agent.tools.length ? el('div', { class: 'rail', 'aria-label': 'What ' + agent.label + ' may use' }, agent.tools.map(function (tool) { return el('span', { class: 'pill', text: toolLabel(tool) }); })) : null,
      el('div', { class: 'studio-row' },
        agent ? button('Edit agent', function () { editAgent(agent.id, { returnTo: 'step', phase: phaseId }); }, { class: 'secondary' }) : null,
        button('Create an agent', function () { openAgentForm({ returnTo: 'step', phase: phaseId }); }, { class: 'secondary' }))
    ], null, agent ? agent.label : 'none'));

    var stepSkills = stepSkillEntries(phase.agent, phaseId, workflowId);
    aside.appendChild(section('skills', 'Skills', stepSkillsBody(phaseId, phase.agent, 'step-skill-'), null,
      stepSkills.length ? stepSkills.map(function (entry) { return skillLabel(entry.id); }).join(', ') : 'none', !stepSkills.length));

    var group = settings.approval.group ? state.draft.groups[settings.approval.group] : null;
    var earlier = workflow.phases.slice(0, Math.max(0, index));
    var signoff = [];
    if (group) {
      var minimum = settings.approval.minimum || 1;
      signoff.push(approvalGroupsEditor(settings));
      var signers = groupsOf(settings.approval);
      var members = signers.reduce(function (all, id) { ((state.draft.groups[id] || { members: [] }).members).forEach(function (member) { var key = member.email || member.githubLogin || member.name; if (all.keys.indexOf(key) < 0) { all.keys.push(key); all.list.push(member); } }); return all; }, { keys: [], list: [] }).list;
      var seats = Math.max(members.length, minimum);
      signoff.push(el('div', { class: 'grid-2' },
        field('step-minimum', 'Approvals needed', el('input', { type: 'text', inputmode: 'numeric', id: 'step-minimum', 'data-key': 'step-minimum', value: String(minimum),
          onchange: function (event) {
            var count = /^\s*\d+\s*$/.test(event.target.value) ? Number(event.target.value) : NaN;
            var floor = Math.max(1, (settings.approval.required || []).filter(function (id) { return signers.indexOf(id) >= 0; }).length);
            if (!Number.isInteger(count) || count < floor || count > 20) { setStatus('Approvals needed is a whole number from ' + floor + ' to 20' + (floor > 1 ? ': one for each group that must approve, at least.' : '.')); render(); return; }
            settings.approval.minimum = count; changed();
          } }), '1 to 20, from all the groups together'),
        el('span')));
      signoff.push(el('div', { class: 'meter', 'aria-hidden': 'true' }, Array.from({ length: Math.min(seats, 8) }, function (unused, at) { return el('span', { class: at < minimum ? 'on' : '' }); })));
      signoff.push(el('span', { class: 'hint', text: members.length ? minimum + ' of ' + members.length + ' must approve' : 'Needs ' + minimum + ' · ' + groupHint(group) }));
      if (members.length) {
        signoff.push(el('div', { class: 'rail' }, members.slice(0, 8).map(function (member) {
          var name = member.name || member.email || member.githubLogin;
          return el('span', { class: 'member' }, el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(name) }), name);
        }), members.length > 8 ? el('span', { class: 'muted', text: '+' + (members.length - 8) }) : null));
      }
      if (signers.every(function (id) { return groupBlocked(id); })) signoff.push(el('div', { class: 'callout bad' }, signers.length > 1 ? 'Nobody is in these groups, so this step could never be approved.' : 'Nobody is in this group, so this step could never be approved.'));
      else signers.filter(function (id) { return groupBlocked(id) && (settings.approval.required || []).indexOf(id) >= 0; }).forEach(function (id) {
        signoff.push(el('div', { class: 'callout bad' }, (state.draft.groups[id] || { label: id }).label + ' must approve, but nobody is in it.'));
      });
      signoff.push(el('div', { class: 'studio-row' }, button('Manage people', function () { state.returnTo = boardReturn(); state.view = 'people'; render(); }, { class: 'secondary' })));
      signoff.push(sendBackEditor(workflow, phaseId, earlier));
    } else {
      signoff.push(el('span', { class: 'hint', text: 'No sign-off: when the agent submits, the Story goes straight on. Turn it on to have people approve this step.' }));
    }
    aside.appendChild(section('signoff', 'Sign-off', signoff, switchControl('step-signoff', 'People sign off this step', Boolean(group), function (on) {
      if (on) {
        var first = Object.keys(state.draft.groups)[0];
        if (!first) { setStatus('Create an approval group in People & approvals first.'); render(); return; }
        settings.approval.group = first; settings.approval.groups = [first]; settings.approval.required = [];
      } else {
        settings.approval.group = null; settings.approval.groups = []; settings.approval.required = [];
        workflow.reworkLoops = workflow.reworkLoops.filter(function (entry) { return entry.from !== phaseId; });
      }
      changed();
    }), group ? group.label + (groupsOf(settings.approval).length > 1 ? ' +' + (groupsOf(settings.approval).length - 1) : '') + ', ' + (settings.approval.minimum || 1) : 'off'));

    var optionalReads = settings.optionalInputs || (settings.optionalInputs = []);
    aside.appendChild(section('reads', 'Reads from earlier steps', earlier.length ? [el('div', { class: 'checks' }, earlier.map(function (input) {
      var reads = settings.inputs.indexOf(input) >= 0;
      return el('div', { class: 'studio-row spread' },
        el('label', null, el('input', { type: 'checkbox', 'data-key': 'reads-' + input, checked: reads, onchange: function (event) {
          settings.inputs = event.target.checked ? settings.inputs.concat([input]) : settings.inputs.filter(function (id) { return id !== input; });
          if (!event.target.checked) settings.optionalInputs = optionalReads.filter(function (id) { return id !== input; });
          settings.inputs.sort(function (a, b) { return workflow.phases.indexOf(a) - workflow.phases.indexOf(b); }); changed();
        } }), stepLabel(input)),
        reads ? el('label', { class: 'muted' }, el('input', { type: 'checkbox', 'data-key': 'optional-' + input, 'aria-label': stepLabel(input) + ' is optional', checked: optionalReads.indexOf(input) >= 0, onchange: function (event) {
          settings.optionalInputs = event.target.checked ? optionalReads.concat([input]) : optionalReads.filter(function (id) { return id !== input; }); changed();
        } }), ' optional') : null);
    })), optionalReads.length ? el('span', { class: 'hint', text: 'An optional input may be missing: a decision can skip the step that writes it, and this step still runs.' }) : null]
      : el('span', { class: 'hint', text: 'This is the first step; it reads the Story itself.' }), null, earlier.length ? settings.inputs.length + ' of ' + earlier.length + (optionalReads.length ? ', ' + optionalReads.length + ' optional' : '') : 'the Story', true));
    aside.appendChild(artifactsSection(workflowId, phaseId));

    aside.appendChild(worldModelSection(workflowId, phaseId, phase));

    var modes = (state.model.choices.clarification || []).filter(function (mode) { return mode.id !== 'off'; });
    var asking = Boolean(phase.clarification && phase.clarification !== 'off');
    var mode = modes.find(function (entry) { return entry.id === phase.clarification; });
    aside.appendChild(section('questions', 'Clarifying questions', asking
      ? field('step-questions', 'When', select('step-questions', modes.map(function (entry) { return { value: entry.id, label: entry.label }; }), phase.clarification, function (value) { phase.clarification = value; changed(); }))
      : el('span', { class: 'hint', text: 'The agent drafts without asking first.' }),
    switchControl('step-asks', 'The agent asks clarifying questions', asking, function (on) {
      phase.clarification = on ? ((modes.find(function (entry) { return entry.id === 'when-needed'; }) || modes[0] || { id: 'off' }).id) : 'off'; changed();
    }), asking ? (mode ? mode.label : phase.clarification) : 'off', true));

    var after = decisionAfterStep(workflow, phaseId);
    aside.appendChild(section('after', 'After this step', after ? [
      el('div', { class: 'callout' }, decisionLines(workflow, after).map(function (line) { return el('div', { text: line }); })),
      el('div', { class: 'studio-row' }, button('Open ' + after.label, function () { openDecision(after); }, { class: 'secondary', 'data-key': 'step-decision', 'aria-label': 'Open the decision ' + after.label }))
    ] : field('step-decision', 'Then', select('step-decision', [{ value: '', label: 'Go to the next step' }].concat(DECISION_KINDS), '', function (value) {
      if (!value) return;
      var created = newDecision(workflow, phaseId, value);
      workflow.decisions = (workflow.decisions || []).concat([created]);
      state.decision = created.id; changed();
    }), 'Add a decision to branch, loop until a goal, or let a person choose.'), null, after ? after.label : 'next step'));

    var actionCount = (settings.afterStep || []).length;
    aside.appendChild(section('actions', 'Actions after this step', actionsEditor(workflowId, phaseId, settings, users), null,
      actionCount ? actionCount + (actionCount === 1 ? ' action' : ' actions') : 'none', !actionCount));

    return aside;
  }

  // ---- After-step actions and integration targets ---------------------------------------------
  //
  // A target is a named place a step can tell about its decisions: your own service, a log service,
  // Teams, the Story's Jira issue, another repository, Confluence or OneDrive. A step's actions say
  // which target hears, when (submitted, approved, rejected) and what it is sent; a required action
  // holds the next step until its approved delivery is recorded. Like sign-off, actions belong to the workflow: on a step two
  // workflows share, each keeps its own. Configuration names secrets but never holds them; each
  // machine keeps its own, and VS Code stores them in the operating-system keychain.

  var SECRET_NAME = /^SFLOW_SECRET_[A-Z0-9_]{1,51}$/;
  var TOKEN_FORMATS = ['splunk-hec', 'datadog', 'elastic'];
  var TRIGGER_WORDS = { submitted: 'submitted', approved: 'approved', rejected: 'rejected' };
  var SEND_WORDS = { event: 'the event', summary: 'a summary', artifact: 'the document' };
  var SEND_LABELS = { event: 'The event', summary: 'A summary with the acceptance criteria', artifact: 'The document' };
  var SECRET_WORDS = { stored: 'Stored on this machine', environment: 'Set in the environment', missing: 'Not set on this machine' };
  var JIRA_WORDS = { stored: 'Connected in VS Code', environment: 'Connected through the environment', missing: 'Not connected on this machine' };
  var JIRA_ISSUE = /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,9}$/;
  var GIT_HTTPS = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[A-Za-z0-9._~\/-]+$/;
  var GIT_SSH = /^(ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[A-Za-z0-9._~\/-]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~][A-Za-z0-9._~\/-]*)$/;
  var GIT_DEFAULT_PATH = 'sflow/{story}/{step}/{file}';
  var DRIVE_DEFAULT_FOLDER = 'sflow/{story}/{step}/generation-{generation}';
  var KIND_HINTS = { webhook: 'Your own service: signed JSON', 'http-log': 'Splunk, Datadog, Elastic, Loki or JSON', teams: 'A message in a Teams channel', jira: 'Comment on, attach to or move the Story issue', git: 'Commit the approved document to a branch', confluence: 'A page per Story and step under a parent page', onedrive: 'Upload the approved document to a folder' };
  var FORMAT_LABELS = { json: 'Any JSON endpoint', 'splunk-hec': 'Splunk HTTP Event Collector', datadog: 'Datadog logs', elastic: 'Elasticsearch', loki: 'Grafana Loki' };

  /** JSON with object keys sorted, so equal targets compare equal however their fields were set. */
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + canonical(value[key]); }).join(',') + '}';
    return JSON.stringify(value === undefined ? null : value);
  }
  function kindOf(kind) {
    return ((state.model && state.model.choices && state.model.choices.integrationKinds) || []).find(function (entry) { return entry.id === kind; })
      || { id: kind, label: kind, available: false, sends: ['event'] };
  }
  function targetIds() { return Object.keys((state.draft && state.draft.integrations) || {}).sort(); }
  function publishedTargets() { return (state.model && state.model.integrations && state.model.integrations.targets) || []; }
  function targetSecrets(target) { return [target.signingSecret, target.tokenSecret, target.urlSecret].filter(Boolean); }
  function targetAddress(target) {
    if (target.kind === 'jira') return target.issue ? 'Issue ' + target.issue : 'The Jira issue each Story was started from';
    if (target.kind === 'git') return target.repository + ' → ' + target.branch + ' · ' + (target.path || GIT_DEFAULT_PATH);
    if (target.kind === 'confluence') return target.url + ' · under page ' + target.parentPage + ' · ' + (target.deployment === 'data-center' ? 'Data Center' : 'Cloud');
    if (target.kind === 'onedrive') return 'Drive ' + target.drive + (target.site ? ' on site ' + target.site : '') + ' · ' + (target.folder || DRIVE_DEFAULT_FOLDER);
    return target.url ? target.url : target.urlSecret ? 'Address kept in ' + target.urlSecret : '';
  }
  /** A Jira status per trigger, as the form shows it; one status for every trigger fills all three. */
  function jiraTransitionFields(transition) {
    var fields = { submitted: '', approved: '', rejected: '' };
    if (typeof transition === 'string') { fields.submitted = transition; fields.approved = transition; fields.rejected = transition; }
    else if (transition) Object.keys(fields).forEach(function (trigger) { fields[trigger] = transition[trigger] || ''; });
    return fields;
  }
  /** A target the configuration has exactly as the draft has it, so the engine can test it now. */
  function targetPublished(id) {
    var published = publishedTargets().find(function (target) { return target.id === id; });
    if (!published || !state.draft.integrations[id]) return false;
    var copy = clone(published); delete copy.id;
    return canonical(copy) === canonical(state.draft.integrations[id]);
  }
  /** One action in words: "On approved, sends the event to team-events". */
  function actionLine(action) {
    return 'On ' + (action.on || []).map(function (trigger) { return TRIGGER_WORDS[trigger] || trigger; }).join(' or ') + ', sends ' + (SEND_WORDS[action.send || 'event'] || action.send) + ' to ' + action.target
      + (action.required ? '; the next step waits for it' : '');
  }
  /** Every step, in every workflow of the draft, whose actions send to a target. */
  function targetUsers(targetId) {
    var users = [];
    Object.keys(state.draft.workflows).forEach(function (workflowId) {
      workflowSteps(workflowId).forEach(function (phaseId) {
        var settings = state.draft.steps[workflowId] && state.draft.steps[workflowId][phaseId];
        ((settings && settings.afterStep) || []).forEach(function (action) {
          if (action.target === targetId) users.push({ workflow: workflowId, step: phaseId, action: action });
        });
      });
    });
    return users;
  }
  function addStepAction(workflowId, phaseId) {
    var targets = targetIds();
    if (!targets.length) { setStatus('Add a target in Integrations first.'); render(); return null; }
    var settings = stepSettings(workflowId, phaseId);
    var list = settings.afterStep || (settings.afterStep = []);
    var target = targets[0];
    var action = { id: uniqueId(target, list.map(function (entry) { return entry.id; })), on: ['approved'], target: target, send: kindOf(state.draft.integrations[target].kind).sends[0] || 'event' };
    list.push(action);
    state.sections.actions = true;
    changed();
    return action;
  }
  function setActionTarget(action, targetId) {
    var target = state.draft.integrations[targetId];
    if (!target) return;
    action.target = targetId;
    var sends = kindOf(target.kind).sends;
    if (sends.indexOf(action.send) < 0) action.send = sends[0] || 'event';
    changed();
  }
  function setActionTrigger(action, trigger, on) {
    var next = ((state.model && state.model.choices.actionTriggers) || ['submitted', 'approved', 'rejected']).filter(function (entry) { return entry === trigger ? on : action.on.indexOf(entry) >= 0; });
    if (!next.length) { setStatus('An action needs at least one moment; remove it to stop it.'); render(); return false; }
    action.on = next;
    // Only the approved delivery can hold the next step, so an action that stops firing on approved stops being required.
    if (action.required && next.indexOf('approved') < 0) { delete action.required; setStatus('Required needs the approved moment, so this action is no longer required.'); }
    changed();
    return true;
  }
  /** Required is kept only when on: an action without it is written exactly as before. */
  function setActionRequired(action, on) {
    if (on && action.on.indexOf('approved') >= 0) action.required = true; else delete action.required;
    changed();
  }

  function actionsEditor(workflowId, phaseId, settings, users) {
    var list = settings.afterStep || (settings.afterStep = []);
    var targets = targetIds();
    var triggers = state.model.choices.actionTriggers || ['submitted', 'approved', 'rejected'];
    var body = [];
    if (users.length && list.length) {
      body.push(el('span', { class: 'hint', text: 'Only ' + state.draft.workflows[workflowId].label + ' sends these; ' + (users.length > 2
        ? 'the ' + users.length + ' other workflows that use this step keep their own.'
        : users.map(function (id) { return state.draft.workflows[id].label; }).join(' and ') + ' keep' + (users.length === 1 ? 's its' : ' their') + ' own.') }));
    }
    list.forEach(function (action, index) {
      var target = state.draft.integrations[action.target];
      var options = targets.map(function (id) { return { value: id, label: state.draft.integrations[id].label || id, title: id + ' · ' + kindOf(state.draft.integrations[id].kind).label }; });
      if (!target) options.unshift({ value: action.target, label: action.target + ' (no longer a target)', disabled: true });
      var sends = target ? kindOf(target.kind).sends : [action.send || 'event'];
      body.push(el('div', { class: 'action-box', role: 'group', 'aria-label': actionLine(action) },
        el('div', { class: 'grid-2' },
          field('action-target-' + index, 'Sends to', select('action-target-' + index, options, action.target, function (value) { setActionTarget(action, value); })),
          field('action-send-' + index, 'What', select('action-send-' + index, sends.map(function (send) { return { value: send, label: SEND_LABELS[send] || send }; }), action.send || 'event', function (value) { action.send = value; changed(); }))),
        el('div', { class: 'field' }, el('span', { class: 'label', text: 'When the step is' }),
          el('div', { class: 'trigger-row' }, triggers.map(function (trigger) {
            return el('label', null, el('input', { type: 'checkbox', 'data-key': 'action-on-' + index + '-' + trigger, checked: action.on.indexOf(trigger) >= 0,
              onchange: function (event) { setActionTrigger(action, trigger, event.target.checked); } }), TRIGGER_WORDS[trigger] || trigger);
          }))),
        el('div', { class: 'trigger-row' }, el('label', { title: action.on.indexOf('approved') >= 0 ? 'The next step, or finishing after the last one, waits until the approved delivery has a receipt in the Story.' : 'Only an action sent when the step is approved can be required.' },
          el('input', { type: 'checkbox', 'data-key': 'action-required-' + index, checked: action.required === true, disabled: action.on.indexOf('approved') < 0,
            onchange: function (event) { setActionRequired(action, event.target.checked); } }), 'Required: the next step waits until the approved delivery is recorded')),
        target ? null : el('div', { class: 'callout bad', text: 'Target ' + action.target + ' was removed. Choose another target or remove this action.' }),
        el('div', { class: 'studio-row spread' }, el('span', { class: 'muted', text: actionLine(action) }),
          button('Remove', function () { settings.afterStep = list.filter(function (entry) { return entry !== action; }); changed(); }, { class: 'secondary', 'aria-label': 'Remove the action: ' + actionLine(action) }))));
    });
    if (!targets.length) {
      body.push(el('div', { class: 'callout' }, el('div', { text: 'Add a target first: your own service, a log service, Teams, Jira, a Git repository, Confluence or OneDrive. Then choose here what this step sends to it, and when.' }),
        button('Open Integrations', function () { state.returnTo = boardReturn(); state.view = 'integrations'; render(); }, { class: 'secondary', style: 'margin-top:6px' })));
    } else {
      body.push(el('div', { class: 'studio-row' },
        button('Add an action', function () { addStepAction(workflowId, phaseId); }, { class: 'secondary', 'data-key': 'action-add' }),
        button('Integrations', function () { state.returnTo = boardReturn(); state.view = 'integrations'; render(); }, { class: 'secondary' })));
    }
    body.push(el('span', { class: 'hint', text: 'Only a required action holds the Story: the next step waits until its approved delivery is recorded. Any other delivery that fails is retried, and Integrations shows it.' }));
    return body;
  }

  function integrationsState() { return state.integrations || (state.integrations = { form: null, tests: {}, asked: {}, secrets: {}, canStore: true }); }

  /** Ask the host which secrets this machine has, once per name; storing or removing one updates it. */
  function askSecretStatus(names) {
    var view = integrationsState();
    var unknown = names.filter(function (name, index) { return SECRET_NAME.test(name) && !view.asked[name] && names.indexOf(name) === index; });
    var jira = !view.askedJira && targetIds().some(function (id) { return state.draft.integrations[id].kind === 'jira'; });
    if (jira) view.askedJira = true;
    if (!unknown.length && !jira) return;
    unknown.forEach(function (name) { view.asked[name] = true; });
    post({ type: 'studio.secretStatus', names: unknown });
  }

  function newTargetForm(kind) {
    return { mode: 'create', id: '', label: '', kind: kind || 'webhook', url: '', format: 'json', signingSecret: '', tokenSecret: '', urlSecret: '', labels: '', network: 'public', timeoutSeconds: '', issue: '', transitions: jiraTransitionFields(null), repository: '', branch: '', path: '', deployment: 'cloud', parentPage: '', user: '', title: '', drive: '', site: '', folder: '', deliverFrom: 'transition', problem: null };
  }
  function editTargetForm(id) {
    var target = state.draft.integrations[id];
    return { mode: 'edit', id: id, label: target.label || '', kind: target.kind, url: target.url || '', format: target.format || 'json',
      signingSecret: target.signingSecret || '', tokenSecret: target.tokenSecret || '', urlSecret: target.urlSecret || '',
      labels: Object.keys(target.labels || {}).map(function (key) { return key + '=' + target.labels[key]; }).join('\n'),
      network: target.network || 'public', timeoutSeconds: target.timeoutSeconds ? String(target.timeoutSeconds) : '',
      issue: target.issue || '', transitions: jiraTransitionFields(target.transition),
      repository: target.repository || '', branch: target.branch || '', path: target.path || '',
      deployment: target.deployment || 'cloud', parentPage: target.parentPage || '', user: target.user || '', title: target.title || '',
      drive: target.drive || '', site: target.site || '', folder: target.folder || '', deliverFrom: target.deliverFrom || 'transition', problem: null };
  }
  /** A secret name made from the target's ID, such as SFLOW_SECRET_TEAM_EVENTS_KEY. */
  function suggestedSecret(id, suffix) {
    var stem = String(id || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 38);
    return 'SFLOW_SECRET_' + (stem ? stem + '_' : '') + suffix;
  }
  /** Fill the secret the kind needs with a name made from the ID, unless someone typed their own. */
  function suggestSecrets(form, previousId) {
    [['signingSecret', 'KEY', form.kind === 'webhook'], ['tokenSecret', 'TOKEN', (form.kind === 'http-log' && TOKEN_FORMATS.indexOf(form.format) >= 0) || form.kind === 'confluence' || form.kind === 'onedrive'], ['urlSecret', 'URL', form.kind === 'teams']].forEach(function (entry) {
      var current = form[entry[0]];
      var ours = !current || current === suggestedSecret(previousId, entry[1]) || current === suggestedSecret(form.id, entry[1]);
      if (ours) form[entry[0]] = entry[2] && form.id ? suggestedSecret(form.id, entry[1]) : '';
    });
  }
  /** What a target means, with the engine's defaults left out, to tell a real edit from a rebuild. */
  function targetMeaning(target) {
    var copy = clone(target);
    if (copy.network === 'public') delete copy.network;
    if (copy.timeoutSeconds === 10) delete copy.timeoutSeconds;
    if (copy.path === GIT_DEFAULT_PATH) delete copy.path;
    if (copy.kind === 'confluence' && copy.deployment === 'cloud') delete copy.deployment;
    if (copy.title === '{story} — {step}') delete copy.title;
    if (copy.folder === DRIVE_DEFAULT_FOLDER) delete copy.folder;
    return canonical(copy);
  }

  /** The target a form describes, in the written shape, or the first thing it is missing. */
  function targetFromForm(form) {
    var id = String(form.id || '').trim();
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 63) return { problem: 'Give the target a lower-case ID such as team-events.' };
    if (form.mode === 'create' && state.draft.integrations[id]) return { problem: 'There is already a target called ' + id + '.' };
    var target = { kind: form.kind };
    if (String(form.label || '').trim()) target.label = String(form.label).trim().slice(0, 80);
    function secret(name, label, required) {
      var value = String(form[name] || '').trim();
      if (!value) return required ? label + ' is required.' : null;
      if (!SECRET_NAME.test(value)) return label + ' must start with SFLOW_SECRET_ and use capitals, digits and underscores, such as ' + suggestedSecret(id, 'KEY') + '.';
      target[name] = value;
      return null;
    }
    var problem = null;
    if (form.kind === 'webhook' || form.kind === 'http-log') {
      var url = String(form.url || '').trim();
      if (!/^https:\/\/[^\s/]+\S*$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(\/\S*)?$/.test(url)) return { problem: 'The address must start with https:// (plain http only to this machine).' };
      target.url = url;
      if (form.kind === 'http-log') target.format = form.format || 'json';
      problem = form.kind === 'webhook' ? secret('signingSecret', 'The signing secret name', false) : secret('tokenSecret', 'The token secret name', TOKEN_FORMATS.indexOf(target.format) >= 0);
      if (problem) return { problem: problem };
      if (form.kind === 'http-log') {
        var labels = {}; var bad = null;
        String(form.labels || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean).forEach(function (line) {
          var at = line.indexOf('='); var key = at > 0 ? line.slice(0, at).trim() : ''; var value = at > 0 ? line.slice(at + 1).trim() : '';
          if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || !value) bad = 'Write each label as name=value on its own line, such as service=sflow.';
          else labels[key] = value;
        });
        if (bad) return { problem: bad };
        if (Object.keys(labels).length) target.labels = labels;
      }
      if (form.network === 'private') target.network = 'private';
    } else if (form.kind === 'teams') {
      problem = secret('urlSecret', 'The name of the secret holding the webhook address', true);
      if (problem) return { problem: problem };
    } else if (form.kind === 'onedrive') {
      var drive = String(form.drive || '').trim();
      if (!/^[A-Za-z0-9!_.-]{1,200}$/.test(drive)) return { problem: 'Give the drive ID of the document library, such as b!Xy3k...' };
      target.drive = drive;
      var driveSite = String(form.site || '').trim();
      if (driveSite) {
        if (!/^[A-Za-z0-9.,_:-]{1,300}$/.test(driveSite)) return { problem: 'The site is a SharePoint site ID such as contoso.sharepoint.com,<id>,<id>, or empty.' };
        target.site = driveSite;
      }
      var folder = String(form.folder || '').trim();
      if (folder && folder !== DRIVE_DEFAULT_FOLDER) {
        var folderNames = (folder.match(/\{[^}]*\}/g) || []).map(function (token) { return token.slice(1, -1); });
        if (folder.charAt(0) === '/' || folder.length > 300 || folder.split('/').some(function (part) { return !/^[A-Za-z0-9 ._(){}-]+$/.test(part) || part.trim() !== part || part === '.' || part === '..'; })
            || folderNames.some(function (name) { return ['story', 'step', 'generation', 'trigger'].indexOf(name) < 0; }) || folderNames.indexOf('generation') < 0) {
          return { problem: 'The folder is a relative path that includes {generation}, such as Specs/{story}/{step}/generation-{generation}.' };
        }
        target.folder = folder;
      }
      problem = secret('tokenSecret', 'The Graph token secret name', true);
      if (problem) return { problem: problem };
    } else if (form.kind === 'confluence') {
      var site = String(form.url || '').trim();
      if (!/^https:\/\/[^\s/]+\S*$/.test(site) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(\/\S*)?$/.test(site)) return { problem: 'The Confluence address must start with https://.' };
      target.url = site;
      if (form.deployment === 'data-center') target.deployment = 'data-center';
      var parentPage = String(form.parentPage || '').trim();
      if (!/^[1-9][0-9]{0,19}$/.test(parentPage)) return { problem: 'The parent page is its numeric ID, shown in the page address.' };
      target.parentPage = parentPage;
      if (form.deployment !== 'data-center') {
        var user = String(form.user || '').trim();
        if (!/^[^@\s]{1,100}@[^@\s]{1,100}$/.test(user)) return { problem: 'Confluence Cloud needs the account email the API token belongs to.' };
        target.user = user;
      }
      problem = secret('tokenSecret', 'The token secret name', true);
      if (problem) return { problem: problem };
      var pageTitle = String(form.title || '').trim();
      if (pageTitle && pageTitle !== '{story} — {step}') {
        var titleNames = (pageTitle.match(/\{[^}]*\}/g) || []).map(function (token) { return token.slice(1, -1); });
        if (pageTitle.length > 200 || titleNames.some(function (name) { return ['story', 'step', 'storyTitle'].indexOf(name) < 0; })) return { problem: 'The title uses only {story}, {step} and {storyTitle}, in at most 200 characters.' };
        target.title = pageTitle;
      }
      if (form.network === 'private') target.network = 'private';
    } else if (form.kind === 'git') {
      var repository = String(form.repository || '').trim();
      if (!GIT_HTTPS.test(repository) && !GIT_SSH.test(repository)) return { problem: 'The repository must be an https:// address with no user or password, or an SSH address such as git@git.example.com:team/docs.git.' };
      target.repository = repository;
      var branch = String(form.branch || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || /^sflow\//.test(branch) || /(^|\/)\.|\.\.|\/\/|\.lock(\/|$)|\/$/.test(branch) || branch.length > 200) return { problem: 'Name an ordinary branch such as docs/approved; sflow/ branches belong to Singularity Flow.' };
      target.branch = branch;
      var where = String(form.path || '').trim();
      if (where) {
        var parts = where.split('/');
        var names = (where.match(/\{[^}]*\}/g) || []).map(function (token) { return token.slice(1, -1); });
        if (where.charAt(0) === '/' || where.length > 300 || parts.some(function (part) { return !/^[A-Za-z0-9._{}-]+$/.test(part) || part === '.' || part === '..' || part.toLowerCase() === '.git'; })
            || names.some(function (name) { return ['story', 'step', 'generation', 'trigger', 'file'].indexOf(name) < 0; })) {
          return { problem: 'The path is relative, such as docs/{story}/{file}, and uses only {story}, {step}, {generation}, {trigger} and {file}.' };
        }
        if (where !== GIT_DEFAULT_PATH) target.path = where;
      }
    } else if (form.kind === 'jira') {
      var issue = String(form.issue || '').trim();
      if (issue) {
        if (!JIRA_ISSUE.test(issue)) return { problem: 'The issue must be a Jira key such as OPS-12, or empty to use each Story issue.' };
        target.issue = issue;
      }
      var moves = {}; var bad = null;
      ['submitted', 'approved', 'rejected'].forEach(function (trigger) {
        var status = String((form.transitions || {})[trigger] || '').trim();
        if (!status) return;
        if (status.length > 80 || /[\u0000-\u001F\u007F]/.test(status)) bad = 'A Jira status has at most 80 characters.'; else moves[trigger] = status;
      });
      if (bad) return { problem: bad };
      var used = Object.keys(moves);
      // The same status for every trigger is written once.
      if (used.length === 3 && moves.submitted === moves.approved && moves.approved === moves.rejected) target.transition = moves.approved;
      else if (used.length) target.transition = moves;
    } else {
      return { problem: kindOf(form.kind).label + ' targets are not available in this version yet.' };
    }
    var timeout = String(form.timeoutSeconds || '').trim();
    if (timeout) {
      if (!/^[0-9]+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 30) return { problem: 'The timeout is a whole number of seconds from 1 to 30.' };
      target.timeoutSeconds = Number(timeout);
    }
    if (form.deliverFrom === 'pipeline') target.deliverFrom = 'pipeline';
    return { id: id, target: target };
  }
  function saveTargetForm() {
    var view = integrationsState();
    var form = view.form;
    if (!form) return null;
    var built = targetFromForm(form);
    if (built.problem) { form.problem = built.problem; render(); return null; }
    var before = state.draft.integrations[built.id];
    if (!before || targetMeaning(before) !== targetMeaning(built.target)) state.draft.integrations[built.id] = built.target;
    view.form = null;
    askSecretStatus(targetSecrets(built.target));
    setStatus(form.mode === 'create' ? 'Target ' + built.id + ' is in your changes. Open a step to choose what it sends there.' : 'Target ' + built.id + ' changed in your changes.');
    changed();
    return built.id;
  }
  function removeTarget(id) {
    var users = targetUsers(id);
    if (users.length) {
      setStatus(id + ' is still used by ' + users.map(function (user) { return stepLabel(user.step) + ' in ' + state.draft.workflows[user.workflow].label; }).join(', ') + '. Remove those actions first.');
      render(); return false;
    }
    delete state.draft.integrations[id];
    changed();
    return true;
  }

  function secretRow(name) {
    var view = integrationsState();
    var source = view.secrets[name];
    return el('div', { class: 'secret-row' },
      el('code', { text: name, title: name }),
      el('span', { class: 'secret-state ' + (source || 'unknown'), text: source ? SECRET_WORDS[source] : 'Checking…' }),
      el('span', { class: 'studio-row' },
        view.canStore ? button(source === 'stored' ? 'Replace' : 'Store', function () { post({ type: 'studio.storeSecret', name: name }); }, { class: 'secondary', 'aria-label': (source === 'stored' ? 'Replace ' : 'Store ') + name }) : null,
        view.canStore && source === 'stored' ? button('Remove', function () { post({ type: 'studio.clearSecret', name: name }); }, { class: 'secondary', 'aria-label': 'Remove ' + name + ' from this machine' }) : null));
  }

  /** Whether this machine has the Jira connection Jira targets use, and a way to connect it. */
  function jiraRow() {
    var view = integrationsState();
    var source = view.jira;
    return el('div', { class: 'secret-row' },
      el('span', { text: 'Jira connection' }),
      el('span', { class: 'secret-state ' + (source || 'unknown'), text: source ? JIRA_WORDS[source] || source : 'Checking…' }),
      view.canStore ? button(source === 'stored' ? 'Reconnect' : 'Connect Jira', function () { post({ type: 'studio.connectJira' }); }, { class: 'secondary' }) : el('span'));
  }

  function testPanel(id, target) {
    var view = integrationsState();
    var sends = kindOf(target.kind).sends;
    var test = view.tests[id] || (view.tests[id] = { trigger: 'approved', send: sends[0] || 'event', busy: null, result: null, failed: null });
    if (!targetPublished(id)) {
      return el('span', { class: 'hint', text: publishedTargets().some(function (entry) { return entry.id === id; }) ? 'Publish your edits to this target to preview or test it.' : 'Publish this target to preview or test it.' });
    }
    function run(sendTest) { test.busy = sendTest ? 'send' : 'preview'; test.failed = null; render(); post({ type: 'studio.integrationTest', target: id, trigger: test.trigger, send: test.send, sendTest: sendTest }); }
    var result = test.result;
    var request = result && result.request;
    var delivery = result && result.delivery;
    return el('div', { class: 'test-box' },
      el('div', { class: 'studio-row' },
        select('test-on-' + id, (state.model.choices.actionTriggers || ['submitted', 'approved', 'rejected']).map(function (trigger) { return { value: trigger, label: 'When ' + trigger }; }), test.trigger,
          function (value) { test.trigger = value; test.result = null; render(); }, { 'aria-label': 'When, for the preview' }),
        select('test-send-' + id, sends.map(function (send) { return { value: send, label: SEND_LABELS[send] || send }; }), test.send,
          function (value) { test.send = value; test.result = null; render(); }, { 'aria-label': 'What, for the preview' }),
        button(test.busy === 'preview' ? 'Building…' : 'Preview the request', function () { run(false); }, { class: 'secondary', disabled: Boolean(test.busy), 'data-key': 'test-preview-' + id }),
        button(test.busy === 'send' ? (target.kind === 'jira' || target.kind === 'git' || target.kind === 'confluence' || target.kind === 'onedrive' ? 'Checking…' : 'Sending…') : (target.kind === 'jira' ? 'Check the connection' : target.kind === 'git' || target.kind === 'confluence' || target.kind === 'onedrive' ? 'Check access' : 'Send a test'), function () { run(true); }, { class: 'secondary', disabled: Boolean(test.busy), 'data-key': 'test-send-now-' + id })),
      test.failed ? el('div', { class: 'callout bad', role: 'alert', text: test.failed }) : null,
      result && result.unavailable ? el('div', { class: 'callout wait', text: 'Not ready on this machine: ' + (result.unavailable.detail || 'a secret it needs is not set.') }) : null,
      result && result.failed ? el('div', { class: 'callout bad', text: result.failed.detail || 'The request cannot be built.' }) : null,
      delivery ? el('div', { class: 'callout ' + (delivery.outcome === 'delivered' ? 'ok' : 'bad'), role: 'status',
        text: (delivery.outcome === 'delivered' ? 'Sent' : 'Not delivered') + (delivery.status ? ' (HTTP ' + delivery.status + ')' : '') + (delivery.detail ? ': ' + delivery.detail : '') + '.' }) : null,
      result && result.plan && result.plan.repository ? el('pre', { class: 'preview-text', 'aria-label': 'The commit a delivery makes' }, 'Repository: ' + result.plan.repository + '\n' + 'Branch: ' + result.plan.branch + ' (fast-forward only)\n' + 'File: ' + result.plan.path + '\n\n' + result.plan.message) : null,
      result && result.plan && result.plan.drive ? el('pre', { class: 'preview-text', 'aria-label': 'The file a delivery uploads' }, 'Drive: ' + result.plan.drive + (result.plan.site ? ' on site ' + result.plan.site : '') + '\n' + 'File: ' + result.plan.file + '\n(never replaces a file already there)') : null,
      result && result.plan && result.plan.parentPage ? el('pre', { class: 'preview-text', 'aria-label': 'The page a delivery writes' }, 'Page: ' + result.plan.title + '\n' + 'Under page ' + result.plan.parentPage + ' at ' + result.plan.url + '\n\n' + result.plan.body) : null,
      result && result.plan && !result.plan.repository && !result.plan.parentPage && !result.plan.drive ? el('pre', { class: 'preview-text', 'aria-label': 'What the delivery writes in Jira' }, 'Issue: ' + (result.plan.issue || 'the issue each Story was started from') + '\n'
        + (result.plan.attachment ? 'Attachment: ' + result.plan.attachment + '\n' : '') + (result.plan.transition ? 'Then moves it to: ' + result.plan.transition + '\n' : '') + '\n' + result.plan.comment) : null,
      result && (result.checks || []).length ? el('ul', { class: 'checks' }, result.checks.map(function (entry) {
        return el('li', { class: entry.ok ? 'ok-text' : 'bad-text' }, (entry.ok ? '✓ ' : '✗ ') + entry.check + (entry.detail ? ': ' + entry.detail : ''));
      })) : null,
      request ? el('pre', { class: 'preview-text', 'aria-label': 'The request, secrets hidden' }, 'POST ' + request.url + '\n'
        + Object.keys(request.headers || {}).map(function (name) { return name + ': ' + request.headers[name]; }).join('\n') + '\n\n' + JSON.stringify(request.body, null, 2)) : null);
  }

  function renderTargetForm(form) {
    var kinds = state.model.choices.integrationKinds || [];
    var card = el('section', { class: 'studio-card', 'aria-label': form.mode === 'create' ? 'New target' : 'Change target ' + form.id });
    card.appendChild(el('h2', { text: form.mode === 'create' ? 'New target' : 'Change ' + form.id }));
    if (form.mode === 'create') {
      card.appendChild(el('div', { class: 'kind-choices', role: 'radiogroup', 'aria-label': 'Kind of target' }, kinds.map(function (kind) {
        return el('button', { type: 'button', class: 'kind-choice', role: 'radio', 'aria-checked': form.kind === kind.id ? 'true' : 'false', 'data-key': 'target-kind-' + kind.id,
          disabled: !kind.available, title: kind.available ? null : 'Not available in this version yet',
          onclick: function () { form.kind = kind.id; form.problem = null; suggestSecrets(form, form.id); render(); } },
        el('strong', { text: kind.label }), el('span', { class: 'muted', text: kind.available ? KIND_HINTS[kind.id] || '' : 'Coming later' }));
      })));
    }
    card.appendChild(el('div', { class: 'grid-2' },
      field('target-id', 'ID', textInput('target-id', form.id, function (value) { var previous = form.id; form.id = value.trim(); suggestSecrets(form, previous); form.problem = null; render(); },
        { disabled: form.mode !== 'create', placeholder: 'team-events' }), form.mode === 'create' ? 'Steps name the target by this ID.' : null),
      field('target-label', 'Name (optional)', textInput('target-label', form.label, function (value) { form.label = value; }, { placeholder: 'Team events' }))));
    if (form.kind === 'webhook' || form.kind === 'http-log') {
      if (form.kind === 'http-log') {
        card.appendChild(field('target-format', 'Log service', select('target-format', (state.model.choices.httpLogFormats || ['json']).map(function (format) { return { value: format, label: FORMAT_LABELS[format] || format }; }), form.format,
          function (value) { form.format = value; suggestSecrets(form, form.id); render(); })));
      }
      card.appendChild(field('target-url', 'Address', textInput('target-url', form.url, function (value) { form.url = value.trim(); },
        { placeholder: form.kind === 'webhook' ? 'https://hooks.example.com/sflow' : 'https://logs.example.com/services/collector' }), 'https:// only; plain http only to this machine. Never put a password or token in the address.'));
      if (form.kind === 'webhook') {
        card.appendChild(field('target-signing', 'Signing secret name (recommended)', textInput('target-signing', form.signingSecret, function (value) { form.signingSecret = value.trim(); }, { placeholder: suggestedSecret(form.id, 'KEY') }),
          'Each request carries an x-sflow-signature made with this secret, so your service can check it came from your team.'));
      } else {
        card.appendChild(field('target-token', 'Token secret name' + (TOKEN_FORMATS.indexOf(form.format) >= 0 ? '' : ' (optional)'), textInput('target-token', form.tokenSecret, function (value) { form.tokenSecret = value.trim(); }, { placeholder: suggestedSecret(form.id, 'TOKEN') }),
          'The API token the log service expects, sent the way it expects it.'));
        card.appendChild(field('target-labels', 'Labels (optional)', el('textarea', { id: 'target-labels', 'data-key': 'target-labels', rows: '3', value: form.labels, placeholder: 'service=sflow', onchange: function (event) { form.labels = event.target.value; } }),
          'One name=value per line, added to every entry: Splunk fields, Datadog tags, Loki labels.'));
      }
      card.appendChild(field('target-network', 'Where it is', select('target-network', [{ value: 'public', label: 'On the internet' }, { value: 'private', label: 'On our private network' }], form.network,
        function (value) { form.network = value; render(); }), form.network === 'private' ? 'Private addresses are allowed because you say so here, where reviewers see it.' : 'Private and internal addresses are refused unless you choose our private network.'));
    } else if (form.kind === 'onedrive') {
      card.appendChild(el('div', { class: 'callout', text: 'OneDrive targets upload the approved document through Microsoft Graph to a folder of a OneDrive or SharePoint library. Each generation has its own folder and nothing is ever replaced. The token is a Graph access token with permission to write files; it expires, so store a fresh one when deliveries say so.' }));
      card.appendChild(el('div', { class: 'grid-2' },
        field('target-drive', 'Drive ID', textInput('target-drive', form.drive, function (value) { form.drive = value.trim(); }, { placeholder: 'b!Xy3k…' }), 'The document library drive.'),
        field('target-site', 'SharePoint site ID (optional)', textInput('target-site', form.site, function (value) { form.site = value.trim(); }, { placeholder: 'contoso.sharepoint.com,…,…' }))));
      card.appendChild(field('target-folder', 'Folder (optional)', textInput('target-folder', form.folder, function (value) { form.folder = value.trim(); }, { placeholder: DRIVE_DEFAULT_FOLDER }), 'Includes {generation}; may use {story}, {step} and {trigger}.'));
      card.appendChild(field('target-token', 'Graph token secret name', textInput('target-token', form.tokenSecret, function (value) { form.tokenSecret = value.trim(); }, { placeholder: suggestedSecret(form.id, 'TOKEN') }), 'A Microsoft Graph access token, stored on each machine that moves Stories.'));
    } else if (form.kind === 'confluence') {
      card.appendChild(el('div', { class: 'callout', text: 'Confluence targets keep one page per Story and step under a parent page, with the step summary or the approved document. A later generation updates the page; an older one never writes over it.' }));
      card.appendChild(el('div', { class: 'grid-2' },
        field('target-url', 'Confluence address', textInput('target-url', form.url, function (value) { form.url = value.trim(); }, { placeholder: 'https://example.atlassian.net/wiki' })),
        field('target-deployment', 'Kind', select('target-deployment', [{ value: 'cloud', label: 'Confluence Cloud' }, { value: 'data-center', label: 'Confluence Data Center' }], form.deployment || 'cloud', function (value) { form.deployment = value; render(); }))));
      card.appendChild(el('div', { class: 'grid-2' },
        field('target-parent', 'Parent page ID', textInput('target-parent', form.parentPage, function (value) { form.parentPage = value.trim(); }, { placeholder: '123456' }), 'The number in the parent page address.'),
        form.deployment === 'data-center' ? el('span') : field('target-user', 'Account email', textInput('target-user', form.user, function (value) { form.user = value.trim(); }, { placeholder: 'flow-bot@example.com' }), 'The account the API token belongs to.')));
      card.appendChild(field('target-token', 'Token secret name', textInput('target-token', form.tokenSecret, function (value) { form.tokenSecret = value.trim(); }, { placeholder: suggestedSecret(form.id, 'TOKEN') }),
        form.deployment === 'data-center' ? 'A personal access token, stored on each machine that moves Stories.' : 'An Atlassian API token, stored on each machine that moves Stories.'));
      card.appendChild(field('target-title', 'Page title (optional)', textInput('target-title', form.title, function (value) { form.title = value; }, { placeholder: '{story} — {step}' }), 'Uses {story}, {step} and {storyTitle}.'));
      card.appendChild(field('target-network', 'Where it is', select('target-network', [{ value: 'public', label: 'On the internet' }, { value: 'private', label: 'On our private network' }], form.network,
        function (value) { form.network = value; render(); })));
    } else if (form.kind === 'git') {
      card.appendChild(el('div', { class: 'callout', text: 'Git targets commit the approved document to a branch, fast-forward only, using the Git credentials of the machine that moves the Story. Use them with actions that send the document. The branch must not be one of this repository that changes only through review.' }));
      card.appendChild(field('target-repository', 'Repository', textInput('target-repository', form.repository, function (value) { form.repository = value.trim(); }, { placeholder: 'https://git.example.com/team/docs.git' }), 'https:// with no user or password, or SSH such as git@git.example.com:team/docs.git.'));
      card.appendChild(el('div', { class: 'grid-2' },
        field('target-branch', 'Branch', textInput('target-branch', form.branch, function (value) { form.branch = value.trim(); }, { placeholder: 'docs/approved' })),
        field('target-path', 'Path (optional)', textInput('target-path', form.path, function (value) { form.path = value.trim(); }, { placeholder: GIT_DEFAULT_PATH }), 'Uses {story}, {step}, {generation}, {trigger} and {file}.')));
    } else if (form.kind === 'jira') {
      card.appendChild(el('div', { class: 'callout', text: 'Jira targets use the Jira connection on the machine that moves the Story: in VS Code, Singularity Flow: Connect Jira Securely. They comment on the issue, attach the approved document when an action sends it, and can move the issue to a status.' }));
      card.appendChild(field('target-issue', 'Issue (optional)', textInput('target-issue', form.issue, function (value) { form.issue = value.trim().toUpperCase(); }, { placeholder: 'OPS-12' }),
        'Leave empty to write to the Jira issue each Story was started from.'));
      card.appendChild(el('div', { class: 'grid-3' }, ['submitted', 'approved', 'rejected'].map(function (trigger) {
        return field('target-move-' + trigger, 'Move when ' + trigger + ' (optional)', textInput('target-move-' + trigger, (form.transitions || {})[trigger] || '', function (value) { form.transitions[trigger] = value; },
          { placeholder: trigger === 'submitted' ? 'In Review' : trigger === 'approved' ? 'Done' : 'In Progress' }));
      })));
    } else if (form.kind === 'teams') {
      card.appendChild(field('target-url-secret', 'Secret holding the webhook address', textInput('target-url-secret', form.urlSecret, function (value) { form.urlSecret = value.trim(); }, { placeholder: suggestedSecret(form.id, 'URL') }),
        'A Teams webhook address is itself a credential, so configuration names the secret that holds it.'));
    }
    card.appendChild(field('target-timeout', 'Timeout in seconds (optional)', textInput('target-timeout', form.timeoutSeconds, function (value) { form.timeoutSeconds = value.trim(); }, { placeholder: '10', inputmode: 'numeric' })));
    card.appendChild(field('target-deliver-from', 'Delivered by', select('target-deliver-from', [{ value: 'transition', label: 'The machine that moves the Story' }, { value: 'pipeline', label: 'A pipeline, with the organisation credentials' }], form.deliverFrom || 'transition',
      function (value) { form.deliverFrom = value; render(); }),
      form.deliverFrom === 'pipeline'
        ? 'A pipeline runs singularity-flow integrations deliver --commit on each pushed step change. It sends only to a target that matches the reviewed configuration on the default branch.'
        : 'The person who submits, approves or rejects the step delivers it, with the secrets on their machine.'));
    if (form.problem) card.appendChild(el('div', { class: 'callout bad', role: 'alert', text: form.problem }));
    card.appendChild(el('div', { class: 'studio-row' },
      button(form.mode === 'create' ? 'Add to changes' : 'Save to changes', function () { saveTargetForm(); }, { class: 'primary', 'data-key': 'target-save' }),
      button('Cancel', function () { integrationsState().form = null; render(); }, { class: 'secondary' })));
    return card;
  }

  function renderIntegrations(main) {
    var view = integrationsState();
    var ids = targetIds();
    backLink(main);
    main.appendChild(el('header', null, el('h1', { text: 'Integrations' }),
      el('p', { class: 'studio-lede', text: 'Targets are the places a step can tell about its decisions: your own service, a log service, a Teams channel, the Jira issue of the Story, a branch of another repository, a Confluence page or a OneDrive or SharePoint folder. Each step chooses what it sends and when, under Actions after this step. Configuration names secrets but never holds them: every machine that moves a Story keeps its own, and VS Code stores yours in the keychain.' })));
    askSecretStatus(ids.reduce(function (names, id) { return names.concat(targetSecrets(state.draft.integrations[id])); }, []));
    if (view.form) main.appendChild(renderTargetForm(view.form));
    else main.appendChild(el('div', { class: 'studio-row' }, button('Add a target', function () { view.form = newTargetForm('webhook'); render(); }, { class: 'primary', 'data-key': 'target-add' })));
    if (!ids.length && !view.form) main.appendChild(el('p', { class: 'muted', text: 'No targets yet. Add one, then open a step and choose what it sends after it is submitted, approved or rejected.' }));
    var published = publishedTargets().map(function (target) { return target.id; });
    var grid = el('div', { class: 'targets-grid' });
    ids.forEach(function (id) {
      var target = state.draft.integrations[id];
      var users = targetUsers(id);
      var isNew = published.indexOf(id) < 0;
      var edited = !isNew && !targetPublished(id);
      var secrets = targetSecrets(target);
      grid.appendChild(el('article', { class: 'studio-card', 'aria-label': 'Target ' + id },
        el('div', { class: 'studio-row spread' },
          el('div', { class: 'studio-row' }, el('strong', { text: target.label || id }), target.label ? el('code', { text: id }) : null, el('span', { class: 'pill', text: kindOf(target.kind).label }),
            isNew ? el('span', { class: 'pill new', text: 'NEW' }) : edited ? el('span', { class: 'pill new', text: 'CHANGED' }) : null),
          el('div', { class: 'studio-row' },
            button('Change', function () { view.form = editTargetForm(id); render(); }, { class: 'secondary', 'aria-label': 'Change ' + id }),
            button('Remove', function () { removeTarget(id); }, { class: 'secondary', 'aria-label': 'Remove ' + id, disabled: users.length > 0,
              title: users.length ? 'Used by ' + users.length + (users.length === 1 ? ' action' : ' actions') + '; remove those first' : null }))),
        el('span', { class: 'muted', text: [targetAddress(target), target.format ? FORMAT_LABELS[target.format] || target.format : null, target.network === 'private' ? 'private network' : null].filter(Boolean).join(' · ') }),
        el('div', { class: 'muted', text: users.length ? 'Sent by ' + users.map(function (user) { return stepLabel(user.step) + ' in ' + state.draft.workflows[user.workflow].label + ' (' + user.action.on.join(', ') + ')'; }).join('; ') : 'No step sends to it yet.' }),
        target.deliverFrom === 'pipeline' ? el('div', { class: 'muted', text: 'Delivered by a pipeline (singularity-flow integrations deliver), not by the machine that moves the Story.' }) : null,
        target.kind === 'jira' ? jiraRow()
          : target.kind === 'git' ? el('span', { class: 'hint', text: 'Uses the Git credentials of the machine that moves the Story; the first delivery proves it can write.' })
          : secrets.length ? el('div', { class: 'secrets' }, secrets.map(secretRow))
            : el('span', { class: 'hint', text: target.kind === 'webhook' ? 'No signing secret: requests are sent unsigned.' : 'No token: entries are sent without one.' }),
        testPanel(id, target)));
    });
    if (ids.length) main.appendChild(grid);
  }

  function openAgentForm(context) {
    var role = (state.model.choices.roles || [])[0];
    state.agentForm = { mode: 'create', role: role ? role.id : 'blank', label: '', description: '', tools: role ? role.tools.slice() : ['read', 'search', 'edit'], views: role ? role.views.slice() : [], instructions: role ? role.instructions : '', defaults: context && context.phase ? [context.phase] : [], context: context || null };
    state.view = 'agents';
    render();
  }

  function editAgent(id, context) {
    if (protectedObject('agents', id)) { setStatus('This agent is used by a seeded workflow. Duplicate the workflow before editing its agent.'); return; }
    var agent = state.draft.agents[id];
    state.agentForm = { mode: 'edit', id: id, role: null, label: agent.label, description: agent.description, tools: agent.tools.slice(), views: agent.views.slice(), instructions: agent.instructions, defaults: [], context: context || null };
    state.view = 'agents';
    render();
  }

  function renderAgents(main) {
    backLink(main);
    main.appendChild(el('div', { class: 'studio-row spread' }, el('div', null, el('h1', { text: 'Agents' }), el('p', { class: 'studio-lede', text: 'An agent drafts the work in the steps it is the default for. Start a new one from a role; no files to edit.' })),
      button('New agent', function () { openAgentForm(null); }, { class: 'primary' })));
    if (state.agentForm) main.appendChild(renderAgentForm());
    var grid = el('div', { class: 'agents-grid' });
    Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); }).forEach(function (id) {
      var agent = state.draft.agents[id];
      var drafts = Object.keys(state.draft.phases).filter(function (phaseId) { return state.draft.phases[phaseId].agent === id; }).map(function (phaseId) { return state.draft.phases[phaseId].label; });
      grid.appendChild(el('article', { class: 'studio-card' },
        el('div', { class: 'studio-row spread' }, el('div', { class: 'studio-row' }, el('span', { class: 'avatar large', 'aria-hidden': 'true', text: initials(agent.label) }), el('strong', { text: agent.label })),
          el('span', { class: 'pill' + (agent.isNew ? ' new' : ''), text: agent.isNew ? 'NEW' : agent.scope === 'repository' ? 'This repository' : 'Packaged' })),
        el('span', { class: 'muted', text: agent.description }),
        el('span', { style: 'font-size:12px', text: drafts.length ? 'Drafts: ' + drafts.join(', ') : 'Not the default for any step yet' }),
        el('div', { class: 'rail' }, agent.tools.map(function (tool) { return el('span', { class: 'pill', text: toolLabel(tool) }); })),
        (agent.skills || []).length ? el('span', { style: 'font-size:12px', text: 'Skills: ' + agent.skills.map(function (entry) { return skillLabel(entry.id) + (entry.phases.length ? ' (' + entry.phases.map(stepLabel).join(', ') + ')' : ''); }).join(', ') }) : null,
        agentResources(id).length ? el('span', { style: 'font-size:12px', text: 'Remote skills and sources: ' + agentResources(id).map(function (resource) { return resource.id; }).join(', ') }) : null,
        button('Attach a skill', function () { openAttachForm(null, id); }, { class: 'secondary', 'aria-label': 'Attach a skill to ' + agent.label }),
        button('Add a skill from a link', function () { var lib = library(); lib.as = 'skill'; lib.attachTo = null; lib.pendingAgent = id; lib.preview = null; lib.target = null; lib.replace = false; state.returnTo = { view: 'agents' }; state.view = 'library'; render(); }, { class: 'secondary', 'aria-label': 'Add a skill from a link to ' + agent.label }),
        button('Edit', function () { editAgent(id, null); }, { class: 'secondary', 'aria-label': 'Edit ' + agent.label }),
        agent.isNew ? button('Remove', function () { askRemoveNewAgent(id); }, { class: 'secondary', 'aria-label': 'Remove ' + agent.label }) : null));
    });
    main.appendChild(grid);
  }

  /** A new, unpublished agent leaves the draft again, once no step uses it. */
  function askRemoveNewAgent(id) {
    var agent = state.draft.agents[id];
    var drafts = Object.keys(state.draft.phases).filter(function (phaseId) { return state.draft.phases[phaseId].agent === id; });
    if (drafts.length) { setStatus('Choose another agent for ' + drafts.map(stepLabel).join(', ') + ' first; ' + agent.label + ' drafts them.'); return; }
    confirmAction('Remove the new agent ' + agent.label + '?', 'It has not been published, so nothing else changes.', 'Remove agent', function () {
      delete state.draft.agents[id]; if (state.agentForm && state.agentForm.id === id) state.agentForm = null;
      setStatus('Removed the new agent ' + agent.label + '.'); changed();
    });
  }

  function agentResources(id) { var agent = (state.model.agents || []).find(function (entry) { return entry.id === id; }); return (agent && agent.resources) || []; }

  function toolLabel(tool) { var entry = (state.model.choices.tools || []).find(function (item) { return item.id === tool; }); return entry ? entry.label : tool; }

  function renderAgentForm() {
    var form = state.agentForm;
    var roles = state.model.choices.roles || [];
    var card = el('section', { class: 'studio-card', 'aria-label': form.mode === 'create' ? 'Create an agent' : 'Edit agent' });
    card.appendChild(el('h2', { text: form.mode === 'create' ? 'Create an agent' : 'Edit ' + form.label }));
    if (form.mode === 'create') {
      card.appendChild(field('agent-role', 'Start from a role', select('agent-role', roles.map(function (role) { return { value: role.id, label: role.label + ': ' + role.hint }; }), form.role, function (value) {
        var role = roles.find(function (entry) { return entry.id === value; });
        form.role = value; if (role) { form.tools = role.tools.slice(); form.views = role.views.slice(); form.instructions = role.instructions; }
        render();
      })));
    }
    var id = form.mode === 'create' ? kebab(form.label) : form.id;
    card.appendChild(el('div', { class: 'grid-2' },
      field('agent-name', 'Name', textInput('agent-name', form.label, function (value) { form.label = value; requestRender(); }, { placeholder: 'Vendor analyst' }), form.mode === 'create' ? (id ? 'ID ' + id + (state.draft.agents[id] ? ' is already used' : '') : 'The ID is made from the name.') : null),
      field('agent-description', 'What it does', textInput('agent-description', form.description, function (value) { form.description = value; }, { placeholder: 'Compares vendor options against the approved intake.' }))));
    card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'What it may use' }),
      el('div', { class: 'grid-3' }, (state.model.choices.tools || []).map(function (tool) {
        return el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'tool-' + tool.id, checked: form.tools.indexOf(tool.id) >= 0, onchange: function (event) {
          form.tools = event.target.checked ? form.tools.concat([tool.id]) : form.tools.filter(function (entry) { return entry !== tool.id; });
        } }), tool.label);
      }))));
    if (form.mode === 'create') {
      card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'Drafts these steps by default' }),
        el('div', { class: 'grid-3' }, Object.keys(state.draft.phases).sort(function (a, b) { return state.draft.phases[a].label.localeCompare(state.draft.phases[b].label); }).map(function (phaseId) {
          return el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'default-' + phaseId, checked: form.defaults.indexOf(phaseId) >= 0, onchange: function (event) {
            form.defaults = event.target.checked ? form.defaults.concat([phaseId]) : form.defaults.filter(function (entry) { return entry !== phaseId; });
          } }), state.draft.phases[phaseId].label);
        })), el('span', { class: 'hint', text: 'A step has one default agent; choosing it here moves the step from its current agent.' })));
    }
    card.appendChild(field('agent-instructions', 'Instructions', el('textarea', { id: 'agent-instructions', 'data-key': 'agent-instructions', onchange: function (event) { form.instructions = event.target.value; } }, form.instructions || ''),
      form.mode === 'create' ? 'The shared operating rules every agent follows are added for you.' : null));
    card.appendChild(el('div', { class: 'studio-row' },
      button(form.mode === 'create' ? 'Add agent to changes' : 'Keep changes', function () { saveAgentForm(); }, { class: 'primary' }),
      button('Cancel', function () { var context = form.context; state.agentForm = null; if (context) { state.view = 'board'; } render(); }, { class: 'secondary' })));
    return card;
  }

  function saveAgentForm() {
    var form = state.agentForm;
    var label = String(form.label || '').trim(); var description = String(form.description || '').trim();
    if (!label || !description) { setStatus('An agent needs a name and one sentence saying what it does.'); return; }
    if (form.mode === 'create') {
      var id = kebab(label);
      if (!id || state.draft.agents[id]) { setStatus('Choose a different name; that agent ID is taken.'); return; }
      state.draft.agents[id] = { id: id, label: label, description: description, tools: form.tools.slice(), views: form.views.slice(), instructions: form.instructions, scope: 'repository', isNew: true, role: form.role };
      form.defaults.forEach(function (phaseId) { if (state.draft.phases[phaseId]) state.draft.phases[phaseId].agent = id; });
      if (form.context && form.context.returnTo === 'board-add' && state.adding) state.adding.agent = id;
      var context = form.context;
      state.agentForm = null;
      if (context) state.view = 'board';
      setStatus('Agent ' + label + ' added to your changes.');
    } else {
      var agent = state.draft.agents[form.id];
      agent.label = label; agent.description = description; agent.tools = form.tools.slice(); agent.views = form.views.slice(); agent.instructions = form.instructions;
      var editContext = form.context;
      state.agentForm = null;
      if (editContext) state.view = 'board';
    }
    changed();
  }

  // ---- Library: skills, templates and agents from a link or a trusted marketplace ------------

  var IMPORT_KINDS = [
    { value: 'library-skill', label: 'A skill for the skill master (any agent can attach it)' },
    { value: 'skill', label: 'A skill for one of your agents' },
    { value: 'template', label: 'A document template for steps' },
    { value: 'agent', label: 'A whole agent' },
    { value: 'mcp-server', label: 'An MCP server for your agents' }
  ];
  var KIND_WORDS = { skill: 'Skill', 'library-skill': 'Skill for the skill master', template: 'Template', agent: 'Agent', generated: 'Generated artifact', workflow: 'Workflow', 'mcp-server': 'MCP server' };

  function library() {
    return state.library || (state.library = { reference: '', as: 'skill', preview: null, busy: null, error: null, target: null, market: null, entries: null, check: null, newMarket: null });
  }

  /** The link or marketplace entry to preview, as the engine names it. */
  function importReference(entry, marketplaceId) { return 'market:' + marketplaceId + '/' + entry.id + '@' + entry.version; }

  /** The ID an import suggests: its own name, the marketplace entry's ID, or the link's file name. */
  function suggestedId(preview) {
    return preview.id || (preview.marketplace && preview.marketplace.entry) || linkId(preview.reference);
  }

  function linkId(reference) {
    var match = /\/([^\/?#]+?)(?:\.agent)?(?:\.md|\.markdown|\.txt)?(?:[?#].*)?$/.exec(String(reference || ''));
    var name = match ? match[1] : '';
    if (/^(skill|readme|index)$/i.test(name)) { var parts = String(reference).split('?')[0].split('/'); name = parts[parts.length - 2] || name; }
    return kebab(name);
  }

  /** Start a preview: the engine fetches, checks and stages the exact bytes. */
  function previewImport(reference, as, target) {
    var lib = library();
    // The link box keeps what the person typed; a marketplace entry is previewed by its reference.
    if (reference.indexOf('market:') !== 0) { lib.reference = reference; lib.as = as; }
    lib.preview = null; lib.error = null; lib.busy = 'preview'; lib.target = target || null;
    render();
    // A skill for the skill master is fetched and checked like any skill; only where it goes differs.
    post({ type: 'studio.importPreview', reference: reference, as: as === 'library-skill' ? 'skill' : as });
  }

  function agentSteps(agentId) {
    return Object.keys(state.draft.phases).filter(function (phaseId) { return state.draft.phases[phaseId].agent === agentId; });
  }

  function stepChecks(prefix, selected, phaseIds, onChange) {
    return el('div', { class: 'grid-3' }, phaseIds.map(function (phaseId) {
      return el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': prefix + phaseId, checked: selected.indexOf(phaseId) >= 0, onchange: function (event) {
        onChange(event.target.checked ? selected.concat([phaseId]) : selected.filter(function (entry) { return entry !== phaseId; }));
      } }), (state.draft.phases[phaseId] || { label: phaseId }).label);
    }));
  }

  function queueImport(change, message) {
    var lib = library();
    state.draft.imports = (state.draft.imports || []).filter(function (existing) { return importKey(existing) !== importKey(change); }).concat([change]);
    lib.preview = null; lib.target = null; lib.reference = ''; lib.error = null;
    setStatus(message);
    changed();
  }

  function importKey(change) {
    if (change.op === 'import.skill' || change.op === 'import.generated') return change.op + ':' + change.agent + '/' + change.id;
    if (change.op === 'import.agent') return change.op + ':' + change.sha256;
    if (change.op === 'import.remove') return change.op + ':' + change.key;
    return change.op + ':' + change.id;
  }

  function renderPreviewCard(lib) {
    var preview = lib.preview;
    var target = lib.target || (lib.target = { agent: '', id: suggestedId(preview), phases: (preview.marketplace && preview.marketplace.phases) || [], optional: false, label: '', withoutDefaults: false, replace: false });
    var card = el('section', { class: 'studio-card', 'aria-label': 'Import preview' });
    card.appendChild(el('div', { class: 'studio-row spread' },
      el('h2', { text: (KIND_WORDS[preview.as] || preview.as) + (preview.marketplace ? ': ' + preview.marketplace.label + ' ' + preview.marketplace.version : preview.source && preview.source.kind === 'mcp' ? ' from an MCP server' : ' from a link') }),
      el('span', { class: 'pill', title: preview.sha256, text: 'SHA-256 ' + preview.sha256.slice(0, 12) + ' · ' + preview.bytes + ' bytes' })));
    card.appendChild(el('span', { class: 'muted', text: 'From ' + preview.reference + (preview.source && preview.source.resolvedUrl && preview.source.resolvedUrl !== preview.reference ? ', served from ' + preview.source.resolvedUrl : '') }));
    if (preview.source && preview.source.kind === 'mcp') {
      card.appendChild(el('span', { class: 'muted', text: 'Read from MCP server ' + preview.source.server + (preview.source.serverInfo && preview.source.serverInfo.name ? ' (' + preview.source.serverInfo.name + ' ' + (preview.source.serverInfo.version || '') + ')' : '') + Object.keys(preview.source.arguments || {}).map(function (name) { return ' · ' + name + '=' + preview.source.arguments[name]; }).join('') }));
    }
    if (preview.details && preview.details.description) card.appendChild(el('span', { text: preview.details.description }));
    (preview.warnings || []).forEach(function (warning) { card.appendChild(el('div', { class: 'callout wait', text: warning })); });
    card.appendChild(el('pre', { class: 'preview-text', 'aria-label': 'Exact content', text: preview.text + (preview.truncated ? '\n…' : '') }));
    card.appendChild(el('p', { class: 'muted', text: 'This exact content is what gets added. It is copied into your configuration, so Stories never fetch it again.' }));
    if (preview.as === 'skill' && lib.as === 'library-skill') {
      var plain = !/^\uFEFF?---\r?\n/.test(preview.text || '');
      card.appendChild(el('div', { class: 'grid-2' },
        field('import-id', 'Skill ID', textInput('import-id', target.id, function (value) { target.id = kebab(value); requestRender(); }), plain ? 'Its name in the skill master.' : 'Must match the name in its SKILL.md.'),
        plain ? field('import-description', 'What it does and when to use it', textInput('import-description', target.description || '', function (value) { target.description = value; }, { placeholder: 'This file is plain Markdown; say what the skill is for.' })) : el('span')));
    } else if (preview.as === 'skill') {
      var agents = Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); });
      var phaseIds = target.agent ? (agentSteps(target.agent).length ? agentSteps(target.agent) : Object.keys(state.draft.phases)) : [];
      // An agent whose own file this repository cannot change gets the skill from the skill master.
      var viaLibrary = Boolean(target.agent) && keepsSkillsInFile(target.agent);
      var plainSkill = !/^\uFEFF?---\r?\n/.test(preview.text || '');
      card.appendChild(el('div', { class: 'grid-2' },
        field('import-agent', 'Which agent uses it', select('import-agent', [{ value: '', label: 'Choose an agent' }].concat(agents.map(function (id) { return { value: id, label: state.draft.agents[id].label }; })), target.agent, function (value) { target.agent = value; target.phases = target.phases.filter(function (phaseId) { return agentSteps(value).indexOf(phaseId) >= 0; }); render(); })),
        field('import-id', 'Skill ID', textInput('import-id', target.id, function (value) { target.id = kebab(value); requestRender(); }), viaLibrary ? 'Its name in the skill master.' : 'Shown in the agent\'s skills table.')));
      if (target.agent) card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'In which of its steps (none chosen: every step it drafts)' }),
        stepChecks('import-step-', target.phases, phaseIds, function (phases) { target.phases = phases; })));
      if (viaLibrary) {
        card.appendChild(el('div', { class: 'callout wait', text: attachmentHint(target.agent) + ' So this skill is added to the skill master and attached to ' + state.draft.agents[target.agent].label + ' for the steps chosen.' }));
        if (plainSkill) card.appendChild(field('import-description', 'What it does and when to use it', textInput('import-description', target.description || '', function (value) { target.description = value; }, { placeholder: 'This file is plain Markdown; say what the skill is for.' })));
      } else {
        card.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'import-optional', checked: target.optional, onchange: function (event) { target.optional = event.target.checked; } }), 'Optional: the agent works without it'));
      }
    } else if (preview.as === 'template') {
      card.appendChild(el('div', { class: 'grid-2' },
        field('import-id', 'Template ID', textInput('import-id', target.id, function (value) { target.id = kebab(value); requestRender(); })),
        field('import-label', 'Name', textInput('import-label', target.label, function (value) { target.label = value; }, { placeholder: 'From its first heading' }))));
      card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'Use it as the template for' }),
        stepChecks('import-step-', target.phases, Object.keys(state.draft.phases).sort(function (a, b) { return state.draft.phases[a].label.localeCompare(state.draft.phases[b].label); }), function (phases) { target.phases = phases; })));
    } else if (preview.as === 'mcp-server') {
      renderMcpServerTarget(card, preview, target);
    } else if (preview.as === 'agent') {
      var details = preview.details || {};
      card.appendChild(el('span', { text: 'Agent ' + (details.label || preview.id) + (details.tools ? ' · may use ' + details.tools.map(toolLabel).join(', ') : '') }));
      if ((details.defaultFor || []).length) {
        card.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'import-without-defaults', checked: target.withoutDefaults, onchange: function (event) { target.withoutDefaults = event.target.checked; } }),
          'Do not let it take over ' + details.defaultFor.map(function (phaseId) { return (state.draft.phases[phaseId] || { label: phaseId }).label; }).join(', ')));
      }
    }
    if (lib.replace) card.appendChild(el('div', { class: 'callout wait', text: 'This replaces what was imported before; the change shows the difference.' }));
    card.appendChild(el('div', { class: 'studio-row' },
      button('Add to changes', function () { addPreviewedImport(); }, { class: 'primary' }),
      button('Cancel', function () { lib.preview = null; lib.target = null; lib.replace = false; lib.attachTo = null; render(); }, { class: 'secondary' })));
    return card;
  }

  function addPreviewedImport() {
    var lib = library(); var preview = lib.preview; var target = lib.target;
    var replace = Boolean(lib.replace);
    if (preview.as === 'skill' && lib.as === 'library-skill') {
      if (!target.id) { setStatus('Give the skill an ID.'); return; }
      var librarySkill = { op: 'import.librarySkill', id: target.id, source: preview.reference, sha256: preview.sha256, replace: replace };
      if (!/^\uFEFF?---\r?\n/.test(preview.text || '')) {
        if (!String(target.description || '').trim()) { setStatus('Say what the skill does and when to use it.'); return; }
        librarySkill.description = String(target.description).trim();
      }
      queueImport(librarySkill, replace ? 'The update of skill ' + target.id + ' is in your changes.' : 'Skill ' + target.id + ' added to the skill master in your changes. Attach it to agents under Skill master.');
      if (lib.attachTo) {
        var attachment = lib.attachTo; lib.attachTo = null;
        state.view = 'board'; state.workflow = attachment.workflow; state.step = attachment.phase; state.returnTo = null;
        attachToStep(attachment.workflow, target.id, attachment.phase, attachment.use || '');
      }
    } else if (preview.as === 'skill') {
      if (!target.agent) { setStatus('Choose the agent that uses this skill.'); return; }
      if (!target.id) { setStatus('Give the skill an ID.'); return; }
      if (keepsSkillsInFile(target.agent)) {
        // Into the skill master, attached to the agent in the attachments file.
        var viaLibrary = { op: 'import.librarySkill', id: target.id, source: preview.reference, sha256: preview.sha256, replace: replace };
        if (!/^\uFEFF?---\r?\n/.test(preview.text || '')) {
          if (!String(target.description || '').trim()) { setStatus('Say what the skill does and when to use it.'); return; }
          viaLibrary.description = String(target.description).trim();
        }
        var owner = state.draft.agents[target.agent];
        owner.skills = (owner.skills || []).filter(function (entry) { return entry.id !== target.id; }).concat([{ id: target.id, phases: target.phases.slice(), use: '' }]);
        queueImport(viaLibrary, 'Skill ' + target.id + ' added to the skill master and attached to ' + owner.label + ' in your changes.');
      } else {
        queueImport({ op: 'import.skill', agent: target.agent, id: target.id, source: preview.reference, sha256: preview.sha256, phases: target.phases.slice(), optional: target.optional, replace: replace },
          'Skill ' + target.id + ' for ' + state.draft.agents[target.agent].label + ' added to your changes.');
      }
    } else if (preview.as === 'template') {
      if (!target.id) { setStatus('Give the template an ID.'); return; }
      var change = { op: 'import.template', id: target.id, source: preview.reference, sha256: preview.sha256, phases: target.phases.slice(), replace: replace };
      if (String(target.label || '').trim()) change.label = String(target.label).trim();
      queueImport(change, 'Template ' + target.id + ' added to your changes.');
    } else if (preview.as === 'mcp-server') {
      queueImport({ op: 'import.mcpServer', source: preview.reference, sha256: preview.sha256, agents: (target.agents || []).slice(), phases: target.phases.slice(), replace: replace },
        'MCP server ' + ((preview.details && preview.details.label) || preview.id) + ' added to your changes.');
    } else {
      queueImport({ op: 'import.agent', source: preview.reference, sha256: preview.sha256, withoutDefaults: target.withoutDefaults, replace: replace },
        'Agent ' + ((preview.details && preview.details.label) || preview.id) + ' added to your changes.');
    }
    lib.replace = false;
  }

  function renderGeneratedForm(lib) {
    var entry = lib.generated; var marketplace = lib.market;
    var agents = Object.keys(state.draft.agents).filter(function (id) { return agentSteps(id).indexOf(entry.phase) >= 0; });
    var card = el('section', { class: 'studio-card', 'aria-label': 'Generated artifact source' });
    card.appendChild(el('h2', { text: 'Generated artifact: ' + entry.label }));
    card.appendChild(el('span', { class: 'muted', text: 'Fetched for each Story from ' + entry.urlTemplate + ' into ' + entry.target + ' when ' + ((state.draft.phases[entry.phase] || { label: entry.phase }).label) + ' starts.' }));
    if (!agents.length) card.appendChild(el('div', { class: 'callout wait', text: 'No agent drafts ' + ((state.draft.phases[entry.phase] || { label: entry.phase }).label) + ' in your workflows, so nothing would fetch it.' }));
    lib.generatedAgent = lib.generatedAgent && agents.indexOf(lib.generatedAgent) >= 0 ? lib.generatedAgent : (agents[0] || '');
    card.appendChild(field('generated-agent', 'Which agent fetches it', select('generated-agent', agents.map(function (id) { return { value: id, label: state.draft.agents[id].label }; }), lib.generatedAgent, function (value) { lib.generatedAgent = value; })));
    card.appendChild(el('div', { class: 'studio-row' },
      button('Add to changes', function () {
        if (!lib.generatedAgent) { setStatus('Choose the agent that fetches it.'); return; }
        queueImport({ op: 'import.generated', agent: lib.generatedAgent, id: entry.id, urlTemplate: entry.urlTemplate, phase: entry.phase, target: entry.target, origin: { marketplace: marketplace.id, index: marketplace.index, entry: entry.id, version: entry.version } },
          'Generated artifact ' + entry.label + ' added to your changes.');
        lib.generated = null;
      }, { class: 'primary', disabled: !agents.length }),
      button('Cancel', function () { lib.generated = null; render(); }, { class: 'secondary' })));
    return card;
  }

  function renderMarketplaces(lib) {
    var section = el('section', { class: 'studio-card', 'aria-label': 'Marketplaces' });
    section.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Marketplaces this repository trusts' }),
      button('Trust a marketplace', function () { lib.newMarket = { id: '', label: '', index: '', origins: '' }; render(); }, { class: 'secondary' })));
    var trusted = (state.model.marketplaces || []).filter(function (market) { return !(state.draft.imports || []).some(function (change) { return change.op === 'marketplace.remove' && change.id === market.id; }); });
    var pending = (state.draft.imports || []).filter(function (change) { return change.op === 'marketplace.add'; });
    if (!trusted.length && !pending.length) section.appendChild(el('p', { class: 'muted', text: 'None yet. A marketplace is a catalog your team publishes; each entry pins its file by hash, and its index can only list files from origins you allow here.' }));
    trusted.forEach(function (market) {
      section.appendChild(el('div', { class: 'check-row' }, el('span', { class: 'mark ok', text: '✓' }),
        el('div', null, el('strong', { text: market.label }), el('div', { class: 'muted', text: market.index + (market.allowedOrigins.length ? ' · files also from ' + market.allowedOrigins.join(', ') : '') })),
        el('div', { class: 'studio-row' },
          button(lib.busy === 'browse:' + market.id ? 'Opening…' : 'Browse', function () { lib.busy = 'browse:' + market.id; lib.market = market; lib.entries = null; lib.error = null; render(); post({ type: 'studio.marketplaceBrowse', id: market.id }); }, { class: 'secondary', 'aria-label': 'Browse ' + market.label }),
          button('Stop trusting', function () { queueImport({ op: 'marketplace.remove', id: market.id }, market.label + ' will no longer be trusted once you publish.'); }, { class: 'secondary', 'aria-label': 'Stop trusting ' + market.label }))));
    });
    pending.forEach(function (change) { section.appendChild(el('div', { class: 'check-row' }, el('span', { class: 'mark wait', text: '…' }), el('div', null, el('strong', { text: change.label || change.id }), el('div', { class: 'muted', text: change.index + ' · trusted once you publish' })), el('span', null))); });
    if (lib.newMarket) section.appendChild(renderNewMarketplace(lib));
    if (lib.market && lib.entries) section.appendChild(renderEntries(lib));
    return section;
  }

  function renderNewMarketplace(lib) {
    var form = lib.newMarket;
    var box = el('div', { class: 'decision-box' });
    box.appendChild(el('div', { class: 'grid-2' },
      field('market-label', 'Name', textInput('market-label', form.label, function (value) { form.label = value; if (!form.id) form.id = kebab(value); requestRender(); }, { placeholder: 'Engineering catalog' })),
      field('market-id', 'ID', textInput('market-id', form.id, function (value) { form.id = kebab(value); }))));
    box.appendChild(field('market-index', 'Index link (sflow-marketplace@1 JSON)', textInput('market-index', form.index, function (value) { form.index = value.trim(); }, { placeholder: 'https://catalog.example.org/sflow-marketplace.json' })));
    box.appendChild(field('market-origins', 'Other places its files may come from (optional)', textInput('market-origins', form.origins, function (value) { form.origins = value; }, { placeholder: 'https://cdn.example.org' }), 'Comma-separated origins. Files from anywhere else are refused.'));
    box.appendChild(el('div', { class: 'studio-row' },
      button('Add to changes', function () {
        if (!form.id || !/^https:\/\//.test(form.index)) { setStatus('A marketplace needs an ID and an https:// index link.'); return; }
        var origins = String(form.origins || '').split(',').map(function (value) { return value.trim(); }).filter(Boolean);
        var change = { op: 'marketplace.add', id: form.id, index: form.index, allowedOrigins: origins };
        if (String(form.label || '').trim()) change.label = String(form.label).trim();
        lib.newMarket = null;
        queueImport(change, 'Marketplace ' + (change.label || change.id) + ' will be trusted once you publish.');
      }, { class: 'primary' }),
      button('Cancel', function () { lib.newMarket = null; render(); }, { class: 'secondary' })));
    return box;
  }

  function renderEntries(lib) {
    var market = lib.market; var result = lib.entries;
    var box = el('div', { class: 'decision-box', 'aria-label': 'Entries in ' + market.label });
    box.appendChild(el('div', { class: 'studio-row spread' }, el('strong', { text: (result.marketplace.name || market.label) + (result.marketplace.publisher ? ' by ' + result.marketplace.publisher : '') }),
      el('div', { class: 'studio-row' },
        textInput('market-search', lib.search || '', function (value) { lib.search = value; render(); }, { placeholder: 'Search entries', 'aria-label': 'Search entries' }),
        button('Close', function () { lib.market = null; lib.entries = null; lib.search = ''; render(); }, { class: 'secondary', 'aria-label': 'Close the entries of ' + market.label }))));
    var query = String(lib.search || '').toLowerCase();
    var entries = result.entries.filter(function (entry) { return !query || [entry.id, entry.label, entry.description || ''].concat(entry.tags || []).some(function (value) { return String(value).toLowerCase().indexOf(query) >= 0; }); });
    if (!entries.length) box.appendChild(el('p', { class: 'muted', text: 'No entries match.' }));
    var grid = el('div', { class: 'agents-grid' });
    entries.forEach(function (entry) {
      grid.appendChild(el('article', { class: 'studio-card' },
        el('div', { class: 'studio-row spread' }, el('strong', { text: entry.label }), el('span', { class: 'pill', text: (KIND_WORDS[entry.kind] || entry.kind) + ' ' + entry.version })),
        entry.description ? el('span', { class: 'muted', text: entry.description }) : null,
        (entry.tags || []).length ? el('div', { class: 'rail' }, entry.tags.map(function (tag) { return el('span', { class: 'pill', text: tag }); })) : null,
        entry.importable
          ? button(entry.kind === 'generated' ? 'Set up' : 'Preview', function () {
            if (entry.kind === 'generated') { lib.generated = entry; lib.preview = null; render(); return; }
            previewImport(importReference(entry, market.id), entry.kind, null);
          }, { class: 'secondary', 'aria-label': (entry.kind === 'generated' ? 'Set up ' : 'Preview ') + entry.label })
          : el('span', { class: 'muted', text: 'This version of Singularity Flow cannot import ' + (KIND_WORDS[entry.kind] || entry.kind).replace(/^[A-Z][a-z]/, function (start) { return start.toLowerCase(); }) + ' entries yet.' })));
    });
    box.appendChild(grid);
    return box;
  }

  function renderImported(lib) {
    var section = el('section', { class: 'studio-card', 'aria-label': 'Imported' });
    section.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Imported into this repository' }),
      button(lib.busy === 'check' ? 'Checking…' : 'Check for updates', function () { lib.busy = 'check'; lib.check = null; render(); post({ type: 'studio.importsCheck' }); }, { class: 'secondary', disabled: !(state.model.imports || []).length || Boolean(lib.busy) })));
    var rows = state.model.imports || [];
    if (!rows.length) section.appendChild(el('p', { class: 'muted', text: 'Nothing yet. What you import is listed here with where it came from.' }));
    rows.forEach(function (row) {
      var removing = (state.draft.imports || []).some(function (change) { return change.op === 'import.remove' && change.key === row.key; });
      var checked = lib.check && lib.check.find(function (entry) { return entry.key === row.key; });
      section.appendChild(el('div', { class: 'check-row' },
        el('span', { class: 'mark ' + (row.status === 'current' ? 'ok' : row.status === 'missing' || row.status.indexOf('edited (') === 0 ? 'bad' : 'wait'), text: row.status === 'current' ? '✓' : '!' }),
        el('div', null, el('strong', { text: row.key }), el('div', { class: 'muted', text: row.source + ' · ' + row.status + (checked ? ' · ' + checked.status + (checked.detail ? ' (' + checked.detail + ')' : '') : '') })),
        el('div', { class: 'studio-row' },
          checked && checked.updateCommand ? button('Review update', function () { reviewUpdate(row, checked); }, { class: 'primary', 'aria-label': 'Review the update to ' + row.key }) : null,
          row.kind === 'mcp-server' && row.status === 'current' ? button('Add host entry', function () { post({ type: 'studio.mcpHostAdd', id: row.target.id }); }, { class: 'secondary', 'aria-label': 'Add the host entry for ' + row.target.id }) : null,
          removing ? el('span', { class: 'pill', text: 'Removed once you publish' }) : button('Remove', function () { queueImport({ op: 'import.remove', key: row.key }, row.key + ' will be removed once you publish.'); }, { class: 'secondary', 'aria-label': 'Remove ' + row.key }))));
    });
    return section;
  }

  /** An update is a fresh preview of the changed source, added with replace and the same target. */
  function reviewUpdate(row, checked) {
    var match = /^singularity-flow import add "([^"]+)"/.exec(checked.updateCommand || '');
    if (!match) return;
    var target = row.target || {};
    library().replace = true;
    // A skill master skill from plain Markdown keeps its description unless the person changes it.
    var description = row.kind === 'library-skill' ? ((state.draft.skills || {})[target.id] || {}).description || '' : '';
    previewImport(match[1], row.kind, { agent: target.agent || '', id: target.id || '', phases: (target.phases || []).slice(), optional: false, label: '', withoutDefaults: false, description: description });
  }

  // ---- Library: from an approved MCP server -----------------------------------------------

  function renderMcpSources(lib) {
    var servers = state.model.mcpSources || [];
    var section = el('section', { class: 'studio-card', 'aria-label': 'From an MCP server' });
    section.appendChild(el('h2', { text: 'From an MCP server' }));
    if (!servers.length) {
      section.appendChild(el('p', { class: 'muted', text: 'No MCP server allows imports yet. A server allows them when its governed policy lists what may be read (mcpServers.<id>.sources), or when you install one from a marketplace.' }));
      return section;
    }
    section.appendChild(el('p', { class: 'muted', text: 'Read a prompt, a resource or a tool\'s answer from an approved server. Singularity Flow starts or contacts the server only after you allow it, and stops it as soon as the import is read.' }));
    servers.forEach(function (server) {
      section.appendChild(el('div', { class: 'check-row' }, el('span', { class: 'mark ok', text: '✓' }),
        el('div', null, el('strong', { text: server.label }), el('div', { class: 'muted', text: [server.sources.prompts.length ? 'prompts ' + server.sources.prompts.join(', ') : null, server.sources.resources.length ? 'resources ' + server.sources.resources.join(', ') : null, server.sources.tools.length ? 'tools ' + server.sources.tools.join(', ') : null].filter(Boolean).join(' · ') })),
        button(lib.busy === 'mcp:' + server.id ? 'Asking…' : 'Show what it offers', function () { lib.busy = 'mcp:' + server.id; lib.mcp = null; lib.error = null; render(); post({ type: 'studio.mcpSources', id: server.id }); }, { class: 'secondary', 'aria-label': 'Show what ' + server.label + ' offers' })));
    });
    if (lib.mcp) section.appendChild(renderMcpOffer(lib));
    return section;
  }

  function renderMcpOffer(lib) {
    var offer = lib.mcp;
    var box = el('div', { class: 'decision-box', 'aria-label': 'Offered by ' + offer.server.label });
    box.appendChild(el('div', { class: 'studio-row spread' },
      el('strong', { text: offer.server.label + (offer.serverInfo && offer.serverInfo.name ? ' (' + offer.serverInfo.name + (offer.serverInfo.version ? ' ' + offer.serverInfo.version : '') + ')' : '') }),
      button('Close', function () { lib.mcp = null; lib.mcpForms = {}; render(); }, { class: 'secondary', 'aria-label': 'Close what ' + offer.server.label + ' offers' })));
    var items = [];
    offer.prompts.forEach(function (prompt) { items.push({ kind: 'Prompt', name: prompt.name, description: prompt.description, arguments: prompt.arguments, reference: prompt.reference, as: 'skill' }); });
    offer.resources.forEach(function (resource) { items.push({ kind: 'Resource', name: resource.name, description: resource.description || resource.uri, arguments: [], reference: resource.reference, as: 'template' }); });
    offer.tools.forEach(function (tool) { items.push({ kind: 'Tool', name: tool.name, description: tool.description, arguments: tool.arguments, reference: tool.reference, as: 'skill' }); });
    if (!items.length) box.appendChild(el('p', { class: 'muted', text: 'It offers nothing its policy allows importing.' }));
    lib.mcpForms = lib.mcpForms || {};
    items.forEach(function (item) {
      var form = lib.mcpForms[item.reference] || (lib.mcpForms[item.reference] = { as: item.as, values: {} });
      var card = el('article', { class: 'studio-card' },
        el('div', { class: 'studio-row spread' }, el('strong', { text: item.name }), el('span', { class: 'pill', text: item.kind })),
        item.description ? el('span', { class: 'muted', text: item.description }) : null);
      item.arguments.forEach(function (argument) {
        var key = 'mcp-arg-' + kebab(item.reference) + '-' + argument.name;
        card.appendChild(field(key, argument.name + (argument.required ? '' : ' (optional)'), textInput(key, form.values[argument.name] || '', function (value) { form.values[argument.name] = value; }), argument.description));
      });
      card.appendChild(el('div', { class: 'studio-row' },
        select('mcp-as-' + kebab(item.reference), [{ value: 'skill', label: 'Use as a skill' }, { value: 'template', label: 'Use as a document template' }], form.as, function (value) { form.as = value; }),
        button('Preview', function () {
          var missing = item.arguments.filter(function (argument) { return argument.required && !String(form.values[argument.name] || '').trim(); });
          if (missing.length) { setStatus('Fill in ' + missing.map(function (argument) { return argument.name; }).join(', ') + ' first.'); return; }
          var values = {};
          Object.keys(form.values).forEach(function (name) { if (String(form.values[name]).trim()) values[name] = String(form.values[name]).trim(); });
          var lib2 = library(); lib2.replace = false;
          lib2.preview = null; lib2.error = null; lib2.busy = 'preview'; lib2.target = null; render();
          post({ type: 'studio.importPreview', reference: item.reference, as: form.as, arguments: values });
        }, { class: 'secondary', 'aria-label': 'Preview ' + item.name })));
      box.appendChild(card);
    });
    return box;
  }

  function renderMcpServerTarget(card, preview, target) {
    var details = preview.details || {};
    var host = details.host || {};
    card.appendChild(el('span', { text: host.type === 'stdio' ? 'Starting it runs: ' + [host.command].concat(host.args || []).join(' ') : 'It connects to: ' + host.url }));
    var policy = details.policy || {};
    card.appendChild(el('span', { class: 'muted', text: (policy.tools && policy.tools.length ? 'Tools for agents: ' + policy.tools.join(', ') : 'No tools listed: chosen agents may use all its tools') + (policy.sources ? ' · imports allowed from it' : '') }));
    target.agents = target.agents || [];
    card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'Which agents may use it' }),
      el('div', { class: 'grid-3' }, Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); }).map(function (agentId) {
        return el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'mcp-agent-' + agentId, checked: target.agents.indexOf(agentId) >= 0, onchange: function (event) {
          target.agents = event.target.checked ? target.agents.concat([agentId]) : target.agents.filter(function (entry) { return entry !== agentId; });
        } }), state.draft.agents[agentId].label);
      }))));
    card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'In which steps (none chosen: every step)' }),
      stepChecks('mcp-step-', target.phases, Object.keys(state.draft.phases).sort(function (a, b) { return state.draft.phases[a].label.localeCompare(state.draft.phases[b].label); }), function (phases) { target.phases = phases; })));
    card.appendChild(el('p', { class: 'muted', text: 'Publishing adds its governed policy and grants the chosen agents its tools. Its host entry is added to your VS Code workspace afterwards, when you choose to.' }));
  }

  // ---- Artifacts ------------------------------------------------------------------------------
  //
  // Templates are the documents a step drafts into; an artifact set names the files a step's bundle
  // holds and which of them are required. Both are edited here and published with the other changes.

  var SECTION_KINDS = [
    { kind: 'narrative', label: 'Narrative', title: 'Context', guidance: 'State the facts, constraints, and boundaries relevant to this decision.' },
    { kind: 'requirements', label: 'Requirements', title: 'Requirements', guidance: 'Use stable REQ-nnn identifiers and cite the governed source for every requirement.' },
    { kind: 'acceptance-criteria', label: 'Acceptance criteria', title: 'Acceptance criteria', guidance: 'Map each AC-nnn to one or more requirements and make the outcome observable.' },
    { kind: 'decision-log', label: 'Decision log', title: 'Decisions', guidance: 'Record decisions that constrain implementation and why the alternatives were rejected.' },
    { kind: 'risk-register', label: 'Risk register', title: 'Risks and mitigations', guidance: 'Capture material delivery, operational, security, and compliance risks.' },
    { kind: 'checklist', label: 'Checklist', title: 'Completion checklist', guidance: 'Keep every check independently verifiable and name the expected evidence.' },
    { kind: 'open-questions', label: 'Open questions', title: 'Open questions', guidance: 'Do not hide assumptions here: name an owner and whether each question blocks progress.' },
    { kind: 'evidence', label: 'Evidence', title: 'Evidence', guidance: 'The managed inputs block is injected here when the phase is prepared.' }
  ];
  var sectionSeq = 0;
  function newSection(kind) {
    var preset = SECTION_KINDS.find(function (entry) { return entry.kind === kind; }) || SECTION_KINDS[0];
    sectionSeq += 1;
    return { id: 'section-' + sectionSeq, kind: preset.kind, title: preset.title, guidance: preset.guidance };
  }
  /** A new kind brings its own heading and guidance, unless the section's were written by hand. */
  function changeSectionKind(sectionDraft, kind) {
    var before = SECTION_KINDS.find(function (entry) { return entry.kind === sectionDraft.kind; });
    var after = SECTION_KINDS.find(function (entry) { return entry.kind === kind; });
    if (!after) return;
    if (!before || sectionDraft.title.trim() === before.title) sectionDraft.title = after.title;
    if (!before || sectionDraft.guidance.trim() === before.guidance) sectionDraft.guidance = after.guidance;
    sectionDraft.kind = kind;
  }
  function sectionMarkdown(section) {
    var guidance = section.guidance.trim() ? '> ' + section.guidance.trim() + '\n\n' : '';
    switch (section.kind) {
      case 'requirements': return guidance + '### REQ-001\n\n- Statement:\n- Rationale:\n- Priority: Must / Should / Could\n- Source citations:\n- Verification method:\n';
      case 'acceptance-criteria': return guidance + '### AC-001\n\n- Given:\n- When:\n- Then:\n- Requirements: REQ-001\n- Source citations:\n';
      case 'decision-log': return guidance + '| ID | Decision | Rationale | Owner | Status |\n| --- | --- | --- | --- | --- |\n| DEC-001 | | | | Proposed |\n';
      case 'risk-register': return guidance + '| ID | Risk | Impact | Likelihood | Mitigation | Owner |\n| --- | --- | --- | --- | --- | --- |\n| RISK-001 | | | | | |\n';
      case 'checklist': return guidance + '- [ ] Check — evidence:\n';
      case 'open-questions': return guidance + '| Question | Blocks | Owner | Resolution |\n| --- | --- | --- | --- |\n| | Yes / No | | |\n';
      case 'evidence': return guidance + '{{inputs}}\n';
      default: return guidance + 'TODO: Author this section from approved evidence.\n';
    }
  }
  /** The template a set of sections makes, exactly as it is written under the templates folder. */
  function templateFromSections(builder) {
    var title = builder.title.trim() || 'Artifact';
    var heading = builder.governs === 'initiative'
      ? '<' + '!-- singularity-flow:initiative-metadata\n{{metadata}}\n--' + '>\n\n# {{initiative.id}} — ' + title
      : '# {{work.id}} — ' + title;
    var purpose = builder.purpose.trim() ? builder.purpose.trim() + '\n' : 'State what decision this artifact supports and what would make it incomplete.\n';
    var sections = builder.sections.map(function (section) { return '## ' + (section.title.trim() || 'Untitled section') + '\n\n' + sectionMarkdown(section); }).join('\n');
    return (heading + '\n\n' + purpose + '\n' + sections).replace(/\s+$/, '') + '\n';
  }
  function safeTemplatePath(value) {
    var text = String(value || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9._\/-]*\.md$/.test(text) && text.split('/').indexOf('..') < 0 ? text : null;
  }
  function artifactsState() { return state.artifacts || (state.artifacts = { templateForm: null, setForm: null }); }
  /** The template file a step's template value names: a catalog reference resolves to its file. */
  function templateKey(value) {
    if (typeof value !== 'string' || value.indexOf('template:') !== 0) return value || null;
    var id = value.slice('template:'.length);
    return Object.keys(state.draft.templates).find(function (relative) { return state.draft.templates[relative].catalogId === id; }) || value;
  }

  /**
   * Where a template is used, in this draft: each step that drafts from it, with the workflows that
   * run the step that way. A workflow's own template for a step wins over the step's own.
   */
  function templateUsers(relative) {
    var byStep = {}; var order = [];
    Object.keys(state.draft.workflows).forEach(function (workflowId) {
      workflowSteps(workflowId).forEach(function (phaseId) {
        var phase = state.draft.phases[phaseId];
        if (!phase) return;
        var step = state.draft.steps[workflowId] && state.draft.steps[workflowId][phaseId];
        if (templateKey((step && step.template) || phase.template) !== relative) return;
        if (!byStep[phaseId]) { byStep[phaseId] = []; order.push(phaseId); }
        byStep[phaseId].push(state.draft.workflows[workflowId].label || workflowId);
      });
    });
    return order.map(function (phaseId) { return stepLabel(phaseId) + ' (' + byStep[phaseId].join(', ') + ')'; });
  }
  /**
   * Whether a Story step may draft from a template: not an Initiative or Epic template, which names
   * the initiative, the Epic's work ID or its Stories instead of the Story, and not a README kept
   * beside the templates.
   */
  var EPIC_MARKERS = ['{{initiative.', 'singularity-flow:initiative-metadata', '{{workId}}', '{{storyId}}'];
  function storyTemplate(relative) {
    var content = state.draft.templates[relative].content || '';
    if (/(^|\/)README\.md$/i.test(relative)) return false;
    return !EPIC_MARKERS.some(function (marker) { return content.indexOf(marker) >= 0; });
  }
  function templateEdited(relative) {
    var before = (state.model.templates || []).find(function (template) { return template.path === relative; });
    return Boolean(before) && state.draft.templates[relative].content !== before.content;
  }
  function setUsers(id) { return Object.keys(state.draft.phases).filter(function (phaseId) { return state.draft.phases[phaseId].artifactSet === id; }); }

  function openTemplateForm(relative, returnTo) {
    if (relative && protectedObject('templateFiles', templateFilePath(relative))) { setStatus('Seeded template: duplicate the workflow before editing its copy.'); return; }
    var template = relative ? state.draft.templates[relative] : null;
    artifactsState().templateForm = { path: relative || '', scope: template ? template.scope : 'new', content: template ? (template.content || '') : '',
      mode: template ? 'write' : 'sections', returnTo: returnTo || null,
      builder: { governs: 'story', title: '', purpose: '', sections: ['narrative', 'decision-log', 'open-questions', 'evidence'].map(newSection) } };
    if (returnTo) state.returnTo = boardReturn();
    state.view = 'artifacts'; render();
  }
  function closeTemplateForm() {
    var form = artifactsState().templateForm;
    artifactsState().templateForm = null;
    if (form && form.returnTo) { var back = state.returnTo; state.returnTo = null; if (back) { state.view = 'board'; state.workflow = back.workflow; state.step = back.step; } }
    render();
  }
  function saveTemplateForm() {
    var form = artifactsState().templateForm;
    var relative = form.scope === 'new' ? safeTemplatePath(form.path) : form.path;
    if (!relative) { setStatus('A template is a .md path inside the templates folder, without "..", such as common/vendor-brief.md.'); return; }
    if (form.scope === 'new' && state.draft.templates[relative]) { setStatus(relative + ' already exists; edit it instead.'); return; }
    if (form.mode === 'sections') {
      var headings = form.builder.sections.map(function (entry) { return entry.title.trim().toLowerCase(); });
      if (!form.builder.sections.length) { setStatus('Add at least one section.'); return; }
      if (new Set(headings).size !== headings.length) { setStatus('Each section needs its own heading.'); return; }
    }
    var content = form.mode === 'sections' ? templateFromSections(form.builder) : form.content;
    if (!String(content || '').trim()) { setStatus('A template needs some content.'); return; }
    var existing = state.draft.templates[relative];
    state.draft.templates[relative] = existing
      ? Object.assign({}, existing, { content: content })
      : { path: relative, scope: 'repository', catalogId: null, label: null, content: content, tooLarge: false, usedBy: [], isNew: true };
    setStatus(existing ? 'Template ' + relative + ' changed in your changes.' : 'Template ' + relative + ' added to your changes.');
    if (form.returnTo) chooseTemplate(form.returnTo.workflow, form.returnTo.step, relative);
    closeTemplateForm(); changed();
  }

  function renderTemplateForm(form) {
    var card = el('section', { class: 'studio-card', 'aria-label': 'Template' });
    card.appendChild(el('h2', { text: form.scope === 'new' ? 'New template' : form.scope === 'packaged' ? 'Customize ' + form.path : 'Edit ' + form.path }));
    if (form.scope === 'packaged') card.appendChild(el('p', { class: 'muted', text: 'Your changes become this repository\'s own copy of the template; the packaged one stays as it was.' }));
    if (form.scope === 'new') card.appendChild(field('template-path', 'File', textInput('template-path', form.path, function (value) { form.path = value; }, { placeholder: 'common/vendor-brief.md' }), 'Inside ' + (state.model.templatesRoot || 'singularity/templates') + '.'));
    card.appendChild(el('div', { class: 'studio-row', role: 'group', 'aria-label': 'How to write it' },
      button('Write', function () { if (form.mode === 'sections') form.content = templateFromSections(form.builder); form.mode = 'write'; render(); }, { class: form.mode === 'write' ? 'primary' : 'secondary', 'aria-pressed': form.mode === 'write' ? 'true' : 'false' }),
      button('Build from sections', function () { form.mode = 'sections'; render(); }, { class: form.mode === 'sections' ? 'primary' : 'secondary', 'aria-pressed': form.mode === 'sections' ? 'true' : 'false' })));
    var text = form.mode === 'sections' ? templateFromSections(form.builder) : form.content;
    if (form.mode === 'write') {
      card.appendChild(field('template-content', 'Template', el('textarea', { id: 'template-content', 'data-key': 'template-content', rows: '16', style: 'width:100%;font-family:var(--vscode-editor-font-family,monospace)', onchange: function (event) { form.content = event.target.value; render(); } }, form.content), 'Markdown. {{work.id}} and {{inputs}} are filled in when the step is prepared.'));
    } else {
      var builder = form.builder;
      card.appendChild(el('div', { class: 'grid-2' },
        field('template-governs', 'Written for', select('template-governs', [{ value: 'story', label: 'A Story step' }, { value: 'initiative', label: 'An Epic or Initiative step' }], builder.governs, function (value) { builder.governs = value; render(); })),
        field('template-title', 'Title', textInput('template-title', builder.title, function (value) { builder.title = value; render(); }, { placeholder: 'Vendor brief' }))));
      card.appendChild(field('template-purpose', 'What it is for', textInput('template-purpose', builder.purpose, function (value) { builder.purpose = value; render(); })));
      builder.sections.forEach(function (sectionDraft, index) {
        card.appendChild(el('div', { class: 'decision-box', 'aria-label': 'Section ' + (index + 1) },
          el('div', { class: 'studio-row spread' },
            select('section-kind-' + index, SECTION_KINDS.map(function (entry) { return { value: entry.kind, label: entry.label }; }), sectionDraft.kind, function (value) { changeSectionKind(sectionDraft, value); render(); }, { 'aria-label': 'Kind of section ' + (index + 1) }),
            el('div', { class: 'studio-row' },
              button('Move up', function () { builder.sections.splice(index - 1, 0, builder.sections.splice(index, 1)[0]); render(); }, { class: 'secondary', disabled: index === 0 }),
              button('Move down', function () { builder.sections.splice(index + 1, 0, builder.sections.splice(index, 1)[0]); render(); }, { class: 'secondary', disabled: index === builder.sections.length - 1 }),
              button('Remove', function () { builder.sections.splice(index, 1); render(); }, { class: 'secondary', disabled: builder.sections.length === 1 }))),
          field('section-title-' + index, 'Heading', textInput('section-title-' + index, sectionDraft.title, function (value) { sectionDraft.title = value; render(); })),
          field('section-guidance-' + index, 'Guidance for the agent', textInput('section-guidance-' + index, sectionDraft.guidance, function (value) { sectionDraft.guidance = value; render(); }))));
      });
      var adding = form.addKind || 'narrative';
      card.appendChild(el('div', { class: 'studio-row' },
        select('section-add', SECTION_KINDS.map(function (entry) { return { value: entry.kind, label: entry.label }; }), adding, function (value) { form.addKind = value; }, { 'aria-label': 'Kind of section to add' }),
        button('Add section', function () { builder.sections.push(newSection(form.addKind || 'narrative')); render(); }, { class: 'secondary' })));
    }
    var preview = el('details', { open: true }, el('summary', { text: 'Preview: what is written to ' + (form.scope === 'new' ? (safeTemplatePath(form.path) || 'the new file') : form.path) }));
    preview.appendChild(el('pre', { class: 'diff', text: text }));
    card.appendChild(preview);
    card.appendChild(el('div', { class: 'studio-row' },
      button('Keep template', saveTemplateForm, { class: 'primary' }),
      button('Cancel', closeTemplateForm, { class: 'secondary' })));
    return card;
  }

  function openSetForm(id) {
    if (id && protectedObject('artifactSets', id)) { setStatus('Seeded artifact set: duplicate the workflow before editing its copy.'); return; }
    var set = id ? state.draft.artifactSets[id] : null;
    artifactsState().setForm = set ? { id: set.id, isNew: false, primary: set.primary, members: clone(set.members) }
      : { id: '', isNew: true, primary: '', members: [{ path: '', role: '', required: true, authority: 'governed' }] };
    render();
  }
  function setFormProblems(form) {
    var problems = [];
    if (form.isNew && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.id) || state.draft.artifactSets[form.id])) problems.push('Give the set an unused lower-case kebab-case ID.');
    if (!form.members.length) problems.push('A set needs at least one member.');
    var paths = form.members.map(function (member) { return member.path.trim(); });
    if (paths.some(function (value) { return !value || value.charAt(0) === '/' || value.split('/').indexOf('..') >= 0; })) problems.push('Every member needs a path inside the step\'s artifact folder, without "..".');
    if (new Set(paths).size !== paths.length) problems.push('Each member path may appear once.');
    if (form.members.some(function (member) { return !member.role.trim(); })) problems.push('Every member needs a role.');
    if (form.members.some(function (member) { return member.authority === 'advisory' && member.required; })) problems.push('An advisory member is a planning aid, so it cannot be required.');
    if (!form.primary || paths.indexOf(form.primary) < 0) problems.push('Choose the primary member: the file the step\'s artifact is.');
    else if (!ARTIFACT_FILE.test(form.primary)) problems.push('The primary member is the file the step writes itself, so it is a .md file name without folders.');
    return problems;
  }
  function keepSetForm() {
    var form = artifactsState().setForm;
    if (!form || setFormProblems(form).length) return;
    var existing = state.draft.artifactSets[form.id];
    state.draft.artifactSets[form.id] = { id: form.id, primary: form.primary, members: form.members.map(function (member) { return { path: member.path, role: member.role, required: Boolean(member.required), authority: member.authority }; }),
      usedBy: existing ? existing.usedBy : [], isNew: existing ? existing.isNew : true };
    // A step in the set writes its primary member, so a new primary renames each step's file.
    setUsers(form.id).forEach(function (phaseId) { state.draft.phases[phaseId].artifactFile = form.primary; });
    artifactsState().setForm = null; setStatus('Artifact set ' + form.id + ' kept in your changes.'); changed();
  }
  function renderSetForm(form) {
    var card = el('section', { class: 'studio-card', 'aria-label': 'Artifact set' });
    card.appendChild(el('h2', { text: form.isNew ? 'New artifact set' : 'Artifact set ' + form.id }));
    if (form.isNew) card.appendChild(field('set-id', 'ID', textInput('set-id', form.id, function (value) { form.id = value.trim(); render(); }, { placeholder: 'vendor-pack' })));
    card.appendChild(el('div', { class: 'grid-3', 'aria-hidden': 'true' },
      el('span', { class: 'lane-label', text: 'FILE' }), el('span', { class: 'lane-label', text: 'ROLE' }), el('span', { class: 'lane-label', text: 'AUTHORITY' })));
    form.members.forEach(function (member, index) {
      card.appendChild(el('div', { class: 'grid-3', style: 'align-items:center', 'aria-label': 'Member ' + (index + 1) },
        textInput('member-path-' + index, member.path, function (value) { member.path = value.trim(); render(); }, { placeholder: 'notes.md', 'aria-label': 'Path of member ' + (index + 1) }),
        textInput('member-role-' + index, member.role, function (value) { member.role = value.trim(); render(); }, { placeholder: 'notes', 'aria-label': 'Role of member ' + (index + 1) }),
        el('div', { class: 'studio-row' },
          select('member-authority-' + index, [{ value: 'governed', label: 'Governed' }, { value: 'advisory', label: 'Advisory' }], member.authority, function (value) { member.authority = value; if (value === 'advisory') member.required = false; render(); }, { 'aria-label': 'Authority of member ' + (index + 1) }),
          el('label', null, el('input', { type: 'checkbox', 'data-key': 'member-required-' + index, checked: member.required, disabled: member.authority === 'advisory', onchange: function (event) { member.required = event.target.checked; render(); } }), ' required'),
          button('Remove', function () { form.members.splice(index, 1); render(); }, { class: 'secondary', disabled: form.members.length === 1, 'aria-label': 'Remove member ' + (index + 1) }))));
    });
    card.appendChild(el('div', { class: 'studio-row' }, button('Add member', function () { form.members.push({ path: '', role: '', required: false, authority: 'governed' }); render(); }, { class: 'secondary' })));
    var paths = form.members.map(function (member) { return member.path; }).filter(Boolean);
    card.appendChild(field('set-primary', 'Primary member', select('set-primary', [{ value: '', label: 'Choose…' }].concat(paths.map(function (value) { return { value: value, label: value }; })), form.primary, function (value) { form.primary = value; render(); }), 'The file the step\'s artifact is; the others sit beside it.'));
    var problems = setFormProblems(form);
    // A blank new set says what it needs once; the list of problems starts when something is typed.
    var started = !form.isNew || form.id || form.members.some(function (member) { return member.path || member.role; });
    if (started) problems.forEach(function (problem) { card.appendChild(el('div', { class: 'callout wait', text: problem })); });
    else card.appendChild(el('span', { class: 'hint', text: 'Give the set an ID, list its files with a role each, and choose the primary member.' }));
    card.appendChild(el('div', { class: 'studio-row' },
      button('Keep set', keepSetForm, { class: 'primary', disabled: problems.length > 0 }),
      button('Cancel', function () { artifactsState().setForm = null; render(); }, { class: 'secondary' })));
    return card;
  }

  function templateRow(relative) {
    var template = state.draft.templates[relative];
    var users = templateUsers(relative);
    var name = relative.slice(relative.lastIndexOf('/') + 1);
    var edited = templateEdited(relative);
    return el('li', { class: 'artifact-row', 'data-filter': (relative + ' ' + (template.label || '') + ' ' + users.join(' ')).toLowerCase() },
      el('div', { class: 'artifact-name' }, el('strong', { text: template.label || name, title: relative }), template.label ? el('code', { text: name }) : null,
        template.isNew ? el('span', { class: 'pill new', text: 'NEW' }) : edited ? el('span', { class: 'pill new', text: 'CHANGED' }) : template.scope === 'packaged' ? el('span', { class: 'pill', title: 'Shipped with Singularity Flow; Customize makes this repository\'s own copy.', text: 'Packaged' }) : null),
      el('span', { class: 'muted artifact-users', title: users.join('; '), text: users.length ? users.join('; ') : 'Not used by a Story workflow' }),
      template.scope === 'repository' && !template.isNew ? button('Open', function () { openFile(templateFilePath(relative)); }, { class: 'secondary', 'aria-label': 'Open ' + relative + ' in an editor' }) : null,
      template.tooLarge ? el('span', { class: 'muted', text: 'Too large to edit here' })
        : button(template.scope === 'packaged' && !template.isNew && !edited ? 'Customize' : 'Edit', function () { openTemplateForm(relative, null); }, { class: 'secondary', 'aria-label': (template.scope === 'packaged' ? 'Customize ' : 'Edit ') + relative }));
  }
  /** Hides the rows that do not match, opening every folder that has a match while there is a filter. */
  function filterTemplates(container, value, count) {
    var needle = String(value || '').trim().toLowerCase();
    var shownAll = 0;
    Array.prototype.forEach.call(container.querySelectorAll('.artifact-group'), function (group) {
      var shown = 0;
      Array.prototype.forEach.call(group.querySelectorAll('.artifact-row'), function (row) {
        var hit = !needle || row.getAttribute('data-filter').indexOf(needle) >= 0;
        row.hidden = !hit; if (hit) shown += 1;
      });
      shownAll += shown;
      var open = needle ? shown > 0 : group.getAttribute('data-open') === 'true';
      group.hidden = Boolean(needle) && shown === 0;
      var list = group.querySelector('.artifact-list'); if (list) list.hidden = !open;
      var chevron = group.querySelector('.chevron'); if (chevron) chevron.textContent = open ? '▾' : '▸';
    });
    if (count) count.textContent = needle ? shownAll + (shownAll === 1 ? ' template' : ' templates') : '';
  }

  function renderArtifacts(main) {
    var view = artifactsState();
    if (!view.templateForm && !view.setForm) backLink(main);
    main.appendChild(el('header', null, el('h1', { text: 'Artifacts' }),
      el('p', { class: 'studio-lede', text: 'A step drafts its document from a template, and an artifact set says which files its bundle holds and which of them are required. Choose them for a step in its properties; edit them here.' })));
    if (view.templateForm) { main.appendChild(renderTemplateForm(view.templateForm)); return; }
    if (view.setForm) { main.appendChild(renderSetForm(view.setForm)); return; }
    var templates = Object.keys(state.draft.templates).sort();
    var templatesCard = el('section', { class: 'studio-card', 'aria-label': 'Templates' });
    templatesCard.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Templates · ' + templates.length }), button('New template', function () { openTemplateForm(null, null); }, { class: 'primary' })));
    if (!templates.length) templatesCard.appendChild(el('p', { class: 'muted', text: 'No templates yet.' }));
    else {
      var count = el('span', { class: 'muted', role: 'status' });
      templatesCard.appendChild(el('div', { class: 'studio-row' },
        el('input', { type: 'text', 'data-key': 'template-filter', value: view.filter || '', placeholder: 'Find a template, step or workflow', 'aria-label': 'Find a template, step or workflow', style: 'flex:1;min-width:0',
          // Typing filters the rows in place; re-rendering would move the caret.
          oninput: function (event) { view.filter = event.target.value; filterTemplates(templatesCard, view.filter, count); },
          onkeydown: function (event) { if (event.key === 'Escape') { event.preventDefault(); event.target.value = ''; view.filter = ''; filterTemplates(templatesCard, '', count); } } }),
        count));
      var folders = {};
      templates.forEach(function (relative) {
        var folder = relative.indexOf('/') >= 0 ? relative.slice(0, relative.lastIndexOf('/')) : '';
        (folders[folder] || (folders[folder] = [])).push(relative);
      });
      Object.keys(folders).sort().forEach(function (folder) {
        var key = 'templates-' + (folder || '.');
        var entries = folders[folder];
        // A folder opens by itself while it holds a template changed in this draft.
        var open = state.sections[key] === undefined ? entries.some(function (relative) { return state.draft.templates[relative].isNew || templateEdited(relative); }) : state.sections[key];
        templatesCard.appendChild(el('section', { class: 'artifact-group', 'data-open': open ? 'true' : 'false' },
          el('button', { type: 'button', class: 'section-toggle', 'aria-expanded': open ? 'true' : 'false', 'data-key': 'section-' + key, onclick: function () { state.sections[key] = !open; render(); } },
            el('span', { class: 'chevron', 'aria-hidden': 'true', text: open ? '▾' : '▸' }), (folder || 'templates') + '/',
            el('span', { class: 'summary', text: entries.length + (entries.length === 1 ? ' template' : ' templates') })),
          el('ul', { class: 'artifact-list', hidden: !open }, entries.map(templateRow))));
      });
      filterTemplates(templatesCard, view.filter, count);
    }
    main.appendChild(templatesCard);
    var sets = Object.keys(state.draft.artifactSets).sort();
    var setsCard = el('section', { class: 'studio-card', 'aria-label': 'Artifact sets' });
    setsCard.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Artifact sets · ' + sets.length }), button('New artifact set', function () { openSetForm(null); }, { class: 'primary' })));
    if (!sets.length) setsCard.appendChild(el('p', { class: 'muted', text: 'No artifact sets. A step without one has a single artifact: the file its template drafts.' }));
    main.appendChild(setsCard);
    sets.forEach(function (id) {
      var set = state.draft.artifactSets[id];
      var users = setUsers(id);
      setsCard.appendChild(el('article', { class: 'decision-box', 'aria-label': 'Artifact set ' + id },
        el('div', { class: 'studio-row spread' },
          el('div', { class: 'studio-row' }, el('strong', { text: id }), set.isNew ? el('span', { class: 'pill new', text: 'NEW' }) : null),
          el('div', { class: 'studio-row' },
            button('Edit', function () { openSetForm(id); }, { class: 'secondary', 'aria-label': 'Edit ' + id }),
            button('Remove', function () {
              if (users.length) { setStatus('Take ' + id + ' off ' + users.map(stepLabel).join(', ') + ' first.'); return; }
              confirmAction('Remove the artifact set ' + id + '?', set.isNew ? 'It has not been published, so nothing else changes.' : 'It is removed when you publish; no step uses it.', 'Remove set', function () { delete state.draft.artifactSets[id]; changed(); });
            }, { class: 'secondary', 'aria-label': 'Remove ' + id }))),
        el('ul', { class: 'set-members' }, set.members.map(function (member) {
          return el('li', null, el('code', { text: member.path }), ' ' + member.role + (member.path === set.primary ? ' · primary' : '') + (member.required ? ' · required' : '') + (member.authority === 'advisory' ? ' · advisory' : ''));
        })),
        el('span', { class: 'muted', text: users.length ? 'Used by ' + users.map(stepLabel).join(', ') : 'Not used by any step yet' })));
    });
  }

  /** A step's template: this workflow's own on a shared step, the step's own otherwise. */
  function chooseTemplate(workflowId, phaseId, value) {
    var phase = state.draft.phases[phaseId]; var settings = stepSettings(workflowId, phaseId);
    if (otherUsers(workflowId, phaseId).length || settings.template) settings.template = value || null;
    else { phase.template = value || null; phase.templateChosen = true; }
    changed();
  }
  function chooseArtifactSet(phaseId, value) {
    var phase = state.draft.phases[phaseId];
    phase.artifactSet = value || null; phase.artifactSetChosen = true;
    var set = value ? state.draft.artifactSets[value] : null;
    if (set) { phase.artifactFile = set.primary; phase.artifactFileChosen = true; }
    changed();
  }
  var ARTIFACT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
  function artifactsSection(workflowId, phaseId) {
    var phase = state.draft.phases[phaseId]; var settings = stepSettings(workflowId, phaseId);
    var current = templateKey(settings.template || phase.template) || '';
    var templates = Object.keys(state.draft.templates).sort().filter(function (relative) { return relative === current || storyTemplate(relative); });
    var options = [{ value: '', label: 'No template' }].concat(templates.map(function (relative) {
      var cut = relative.lastIndexOf('/');
      var name = relative.slice(cut + 1);
      return { value: relative, group: cut >= 0 ? relative.slice(0, cut) + '/' : 'templates/', label: state.draft.templates[relative].label ? state.draft.templates[relative].label + ' · ' + name : name };
    }));
    if (current && templates.indexOf(current) < 0) options.push({ value: current, label: current });
    options.push({ value: '__new__', label: 'Create a new template…' });
    var sets = Object.keys(state.draft.artifactSets).sort();
    var set = phase.artifactSet ? state.draft.artifactSets[phase.artifactSet] : null;
    var shared = otherUsers(workflowId, phaseId).length > 0;
    return section('artifacts', 'Artifacts', [
      field('step-template', 'Template', select('step-template', options, current, function (value) {
        if (value === '__new__') { openTemplateForm(null, { workflow: workflowId, step: phaseId }); return; }
        chooseTemplate(workflowId, phaseId, value);
      }), shared ? 'This step is shared, so the template is this workflow\'s own choice.' : null),
      current && state.draft.templates[current] ? el('div', { class: 'studio-row' }, button(state.draft.templates[current].scope === 'packaged' ? 'Customize template' : 'Edit template', function () { openTemplateForm(current, { workflow: workflowId, step: phaseId }); }, { class: 'secondary' })) : null,
      field('step-artifact-file', 'File it writes', textInput('step-artifact-file', phase.artifactFile || '', function (value) {
        var name = value.trim();
        if (!ARTIFACT_FILE.test(name)) { setStatus('The file a step writes is a .md file name without folders, like vendor-brief.md.'); render(); return; }
        phase.artifactFile = name; phase.artifactFileChosen = true; changed();
      }, { disabled: Boolean(set), placeholder: phaseId + '.md' }), set ? 'The primary member of ' + set.id + '.' : (shared ? 'The step\'s own file, in every workflow that uses it.' : null)),
      field('step-artifact-set', 'Artifact set', select('step-artifact-set', [{ value: '', label: 'None: one artifact' }].concat(sets.map(function (id) { return { value: id, label: id }; })), phase.artifactSet || '', function (value) { chooseArtifactSet(phaseId, value); }),
        set ? set.members.length + ' member(s); primary ' + set.primary : 'Edit sets under Artifacts.')
    ], null, (current ? current.split('/').pop() : 'no template') + (set ? ' · ' + set.id : ''), true);
  }

  // ---------------------------------------------------------------------------------------------
  // Skill master

  function skillsView() { return state.skillsView || (state.skillsView = { form: null, attach: null }); }
  function skillLabel(id) { var skill = (state.draft.skills || {})[id]; return skill ? skill.label : id; }
  /** Skills waiting to be imported into the skill master; they can be attached before publishing. */
  function pendingLibrarySkills() {
    return (state.draft.imports || []).filter(function (change) { return change.op === 'import.librarySkill' && !(state.draft.skills || {})[change.id]; }).map(function (change) { return change.id; });
  }
  function attachmentOf(agentId, skillId) {
    var agent = state.draft.agents[agentId];
    return agent ? (agent.skills || []).find(function (entry) { return entry.id === skillId; }) || null : null;
  }
  function skillUsers(skillId) {
    return Object.keys(state.draft.agents).filter(function (agentId) { return Boolean(attachmentOf(agentId, skillId)); })
      .sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); });
  }
  /** Both scopes apply in this workflow step; agent skills follow the selected agent. */
  function stepSkillEntries(agentId, phaseId, workflowId) {
    workflowId = workflowId || state.workflow;
    var agent = agentId ? state.draft.agents[agentId] : null;
    var workflow = state.draft.workflows[workflowId || state.workflow];
    return (agent ? (agent.skills || []).map(function (entry) { return Object.assign({}, entry, { scope: 'agent' }); }) : [])
      .concat((workflow ? workflow.skills || [] : []).map(function (entry) { return Object.assign({}, entry, { scope: 'workflow' }); }))
      .filter(function (entry) { return !entry.phases.length || entry.phases.indexOf(phaseId) >= 0; });
  }
  function attachmentsPath() { return (state.model && state.model.skillAttachmentsPath) || 'singularity/skill-library/attachments.yml'; }
  /**
   * Where an agent's skills are written: an agent this repository owns keeps them in its own file;
   * a packaged agent, or one a seeded workflow uses, in the attachments file, so it is never changed.
   */
  function keepsSkillsInFile(agentId) {
    var agent = state.draft.agents[agentId];
    return Boolean(agent) && !(agent.scope === 'repository' && !protectedObject('agents', agentId));
  }
  function attachmentHint(agentId) {
    var agent = state.draft.agents[agentId];
    if (!agent) return null;
    if (!keepsSkillsInFile(agentId)) return 'Kept in ' + agent.label + '\'s own agent file.';
    return agent.label + (protectedObject('agents', agentId) ? ' belongs to a seeded workflow' : ' comes with Singularity Flow') + ', so its skills are kept in ' + attachmentsPath() + ' and the agent itself is not changed.';
  }
  /** Use a skill in one more step: added to the steps it applies in, or attached for this step only. */
  function attachToStep(workflowId, skillId, phaseId, use) {
    var workflow = state.draft.workflows[workflowId];
    if (!workflow || workflow.phases.indexOf(phaseId) < 0) { setStatus('Choose a step in this workflow.'); return; }
    var entry = (workflow.skills || []).find(function (item) { return item.id === skillId; });
    if (entry) {
      workflow.skills = workflow.skills.map(function (item) {
        if (item.id !== skillId) return item;
        return Object.assign({}, item, { phases: item.phases.length && item.phases.indexOf(phaseId) < 0 ? item.phases.concat([phaseId]) : item.phases.slice(), use: use || item.use || '' });
      });
    } else {
      workflow.skills = (workflow.skills || []).concat([{ id: skillId, phases: [phaseId], use: use || '' }]);
    }
    setStatus(workflow.label + ' uses ' + skillLabel(skillId) + ' in ' + stepLabel(phaseId) + '. Other workflows are unchanged.');
    changed();
  }
  /** Stop using a workflow skill in one step; agent attachments are untouched. */
  function detachFromStep(workflowId, skillId, phaseId) {
    var workflow = state.draft.workflows[workflowId];
    var entry = workflow && (workflow.skills || []).find(function (item) { return item.id === skillId; });
    if (!entry) return;
    var remaining = (entry.phases.length ? entry.phases : workflow.phases).filter(function (id) { return id !== phaseId; });
    if (remaining.length) {
      workflow.skills = workflow.skills.map(function (item) { return item.id === skillId ? Object.assign({}, item, { phases: remaining }) : item; });
    } else {
      workflow.skills = workflow.skills.filter(function (item) { return item.id !== skillId; });
    }
    setStatus(skillLabel(skillId) + ' removed from this workflow step. Agent skills and other workflows are unchanged.');
    changed();
  }
  /** The form for adding a skill to one step; it starts over when another step is shown. */
  function stepSkillForm(phaseId, agentId) {
    var view = skillsView();
    var key = state.workflow + '/' + agentId + '/' + phaseId;
    if (!view.step || view.step.key !== key) view.step = { key: key, skill: '', use: '' };
    return view.step;
  }
  function saveStepSkill(phaseId, agentId) {
    var form = stepSkillForm(phaseId, agentId);
    var use = String(form.use || '').replace(/\s+/g, ' ').trim();
    if (!form.skill) { setStatus('Choose a skill to add.'); return; }
    if (use.indexOf('|') >= 0) { setStatus('"When to use it" cannot contain "|".'); return; }
    if (use.length > 300) { setStatus('"When to use it" must be at most 300 characters.'); return; }
    var skillId = form.skill;
    skillsView().step = null;
    attachToStep(state.workflow, skillId, phaseId, use);
  }
  /** A step's skills: those its agent uses in it, with add, write and remove for this step. */
  function stepSkillsBody(phaseId, agentId, prefix) {
    var agent = agentId ? state.draft.agents[agentId] : null;
    var entries = stepSkillEntries(agentId, phaseId);
    var form = stepSkillForm(phaseId, agentId);
    var available = Object.keys(state.draft.skills || {}).concat(pendingLibrarySkills())
      .filter(function (id) { return !entries.some(function (entry) { return entry.id === id && entry.scope === 'workflow'; }); })
      .sort(function (a, b) { return skillLabel(a).localeCompare(skillLabel(b)); });
    return [
      entries.length ? el('ul', { class: 'change-list', 'aria-label': 'Skills in ' + stepLabel(phaseId) }, entries.map(function (entry) {
        var others = entry.phases.filter(function (id) { return id !== phaseId; });
        return el('li', { class: 'studio-row spread' },
          el('span', { style: 'font-size:12px' }, el('strong', { text: skillLabel(entry.id) }),
            el('span', { class: 'muted', text: ' · ' + (entry.scope === 'agent' ? 'Inherited from ' + agent.label : 'This workflow only') + (others.length ? ' · also in ' + others.map(stepLabel).join(', ') : '') + (entry.use ? ' · ' + entry.use : '') })),
          entry.scope === 'workflow' ? button('Remove', function () { detachFromStep(state.workflow, entry.id, phaseId); }, { class: 'secondary', 'aria-label': 'Remove ' + skillLabel(entry.id) + ' from ' + stepLabel(phaseId) }) : el('span', { class: 'hint', text: 'Edit on agent' }));
      })) : el('span', { class: 'hint', text: 'No attached skills in this step yet.' }),
      el('div', { class: 'grid-2' },
        field(prefix + 'choice', 'Add a skill', select(prefix + 'choice', [{ value: '', label: available.length ? 'Choose a skill…' : 'No other skills yet' }]
          .concat(available.map(function (id) { return { value: id, label: skillLabel(id) }; })).concat([{ value: '__new__', label: 'Write a new skill…' }]), form.skill, function (value) {
          if (value === '__new__') { openSkillForm(null, { workflow: state.workflow, phase: phaseId, use: form.use }); return; }
          form.skill = value; render();
        })),
        field(prefix + 'use', 'When to use it', textInput(prefix + 'use', form.use, function (value) { form.use = value; }, { placeholder: 'Before you publish' }))),
      el('div', { class: 'studio-row' }, button('Add to this step', function () { saveStepSkill(phaseId, agentId); }, { class: 'secondary', disabled: !form.skill, 'data-key': prefix + 'add' }),
        button('Add from a link', function () { var lib = library(); lib.as = 'library-skill'; lib.preview = null; lib.target = null; lib.replace = false; lib.attachTo = { workflow: state.workflow, phase: phaseId, use: form.use }; state.returnTo = boardReturn(); state.view = 'library'; render(); }, { class: 'secondary' })),
      el('span', { class: 'hint', text: 'Step skills apply only in this workflow. Inherited agent skills follow the agent wherever it is used.' })
    ];
  }

  function renderSkills(main) {
    var view = skillsView();
    backLink(main);
    main.appendChild(el('div', { class: 'studio-row spread' },
      el('div', null, el('h1', { text: 'Skill master' }),
        el('p', { class: 'studio-lede', text: 'Attach skills to workflow steps for that workflow only, or to agents wherever they are used. Both are included in the phase prompt. Running Stories keep the exact skill text they started with.' })),
      el('div', { class: 'studio-row' },
        button('Add from a link', function () { var lib = library(); lib.as = 'library-skill'; lib.attachTo = null; lib.preview = null; lib.target = null; lib.replace = false; state.returnTo = { view: 'skills' }; state.view = 'library'; render(); }, { class: 'secondary' }),
        button('New skill', function () { openSkillForm(null); }, { class: 'primary' }))));
    if (view.form) main.appendChild(renderSkillForm(view.form));
    if (view.attach) main.appendChild(renderAttachForm(view.attach));
    var ids = Object.keys(state.draft.skills || {}).sort(function (a, b) { return state.draft.skills[a].label.localeCompare(state.draft.skills[b].label); });
    var pending = pendingLibrarySkills();
    ((state.model && state.model.skillProblems) || []).forEach(function (problem) { main.appendChild(el('div', { class: 'callout bad', role: 'alert', text: problem.message })); });
    if (!ids.length && !pending.length) {
      main.appendChild(el('section', { class: 'studio-card', 'aria-label': 'No skills yet' }, el('h2', { text: 'No skills yet' }),
        el('p', { class: 'muted', text: 'Write one with New skill, or add one from a link or a marketplace your repository trusts.' })));
      return;
    }
    var grid = el('div', { class: 'agents-grid' });
    ids.forEach(function (id) { grid.appendChild(renderSkillCard(id)); });
    pending.forEach(function (id) {
      grid.appendChild(el('article', { class: 'studio-card', 'aria-label': 'Skill ' + id },
        el('div', { class: 'studio-row spread' }, el('strong', { text: id }), el('span', { class: 'pill new', text: 'IMPORT' })),
        el('span', { class: 'muted', text: 'Waiting to be imported with your changes.' }),
        renderSkillUsers(id),
        el('div', { class: 'studio-row' }, button('Attach to an agent', function () { openAttachForm(id, null); }, { class: 'secondary', 'aria-label': 'Attach ' + id + ' to an agent' }))));
    });
    main.appendChild(grid);
  }

  function renderSkillUsers(id) {
    var users = skillUsers(id);
    var workflows = Object.values(state.draft.workflows).filter(function (workflow) { return (workflow.skills || []).some(function (entry) { return entry.id === id; }); });
    if (!users.length && !workflows.length) return el('span', { style: 'font-size:12px', text: 'No agent or workflow uses it yet' });
    return el('ul', { class: 'change-list', 'aria-label': 'Attachments of ' + skillLabel(id) }, users.map(function (agentId) {
      var entry = attachmentOf(agentId, id);
      return el('li', { class: 'studio-row spread' },
        el('span', { style: 'font-size:12px', title: entry.origin === 'attachments' ? 'Kept in ' + attachmentsPath() : null, text: state.draft.agents[agentId].label + ' · ' + (entry.phases.length ? entry.phases.map(stepLabel).join(', ') : 'every step it drafts') + (entry.use ? ' · ' + entry.use : '') }),
        el('span', { class: 'studio-row' },
          button('Change', function () { openAttachForm(id, agentId); }, { class: 'secondary', 'aria-label': 'Change how ' + state.draft.agents[agentId].label + ' uses ' + skillLabel(id) }),
          button('Detach', function () { detachSkill(agentId, id); }, { class: 'secondary', 'aria-label': 'Detach ' + skillLabel(id) + ' from ' + state.draft.agents[agentId].label })));
    }).concat(workflows.map(function (workflow) {
      var entry = workflow.skills.find(function (item) { return item.id === id; });
      return el('li', { style: 'font-size:12px', text: 'Workflow: ' + workflow.label + ' · ' + (entry.phases.length ? entry.phases.map(stepLabel).join(', ') : 'every step') });
    })));
  }

  function renderSkillCard(id) {
    var skill = state.draft.skills[id];
    return el('article', { class: 'studio-card', 'aria-label': 'Skill ' + skill.label },
      el('div', { class: 'studio-row spread' }, el('strong', { text: skill.label }), el('span', { class: 'pill' + (skill.isNew ? ' new' : ''), title: id, text: skill.isNew ? 'NEW' : id })),
      el('span', { class: 'muted', text: skill.description }),
      renderSkillUsers(id),
      el('div', { class: 'studio-row' },
        button('Attach to an agent', function () { openAttachForm(id, null); }, { class: 'secondary', 'aria-label': 'Attach ' + skill.label + ' to an agent' }),
        button('Edit', function () { openSkillForm(id); }, { class: 'secondary', 'aria-label': 'Edit ' + skill.label }),
        button('Delete', function () { askRemoveSkill(id); }, { class: 'secondary', 'aria-label': 'Delete ' + skill.label })));
  }

  function openSkillForm(id, attachTo) {
    if (id && protectedObject('skills', id)) { setStatus('Seeded skill: duplicate the workflow before editing its copy.'); return; }
    var skill = id ? state.draft.skills[id] : null;
    var view = skillsView();
    view.form = { mode: id ? 'edit' : 'create', id: id, label: skill ? skill.label : '', description: skill ? skill.description : '', instructions: skill ? skill.instructions : '', loading: skill ? skill.loading || 'eager' : 'eager', attachTo: attachTo || null };
    if (attachTo) state.returnTo = boardReturn();
    view.attach = null; state.view = 'skills'; render();
  }
  /** Back to the step a skill form was opened from. */
  function closeSkillForm() {
    var form = skillsView().form;
    skillsView().form = null;
    var back = form && form.attachTo ? state.returnTo : null;
    if (back) { state.returnTo = null; state.view = 'board'; state.workflow = back.workflow; state.step = back.step; }
    render();
  }

  function renderSkillForm(form) {
    var card = el('section', { class: 'studio-card', 'aria-label': form.mode === 'create' ? 'Create a skill' : 'Edit skill' });
    card.appendChild(el('h2', { text: form.mode === 'create' ? 'Create a skill' : 'Edit ' + form.label }));
    if (form.attachTo) card.appendChild(el('p', { class: 'muted', text: 'Added only to ' + stepLabel(form.attachTo.phase) + ' in this workflow when you add it to your changes.' }));
    var id = form.mode === 'create' ? kebab(form.label) : form.id;
    card.appendChild(el('div', { class: 'grid-2' },
      field('skill-name', 'Name', textInput('skill-name', form.label, function (value) { form.label = value; requestRender(); }, { placeholder: 'Security review' }),
        form.mode === 'create' ? (id ? 'ID ' + id + (state.draft.skills[id] ? ' is already used' : '') : 'The ID is made from the name.') : 'ID ' + id),
      field('skill-description', 'What it does and when to use it', textInput('skill-description', form.description, function (value) { form.description = value; }, { placeholder: 'Checks a change for common security mistakes before it is published.' }))));
    card.appendChild(field('skill-instructions', 'Instructions', el('textarea', { id: 'skill-instructions', 'data-key': 'skill-instructions', rows: 12, onchange: function (event) { form.instructions = event.target.value; } }, form.instructions || ''),
      'What the agent does when it uses this skill, step by step. Markdown.'));
    card.appendChild(field('skill-loading', 'Prompt loading', select('skill-loading', [
      { value: 'eager', label: 'Eager — instructions in every applicable prompt' },
      { value: 'on-demand', label: 'On demand — optional self-contained procedure' }
    ], form.loading || 'eager', function (value) { form.loading = value; }),
    'Keep safety, correctness and policy skills eager. On-demand skills retain exact bytes and use a verified Story retrieval command before application; a use description alone never defers loading.'));
    card.appendChild(el('div', { class: 'studio-row' },
      button(form.mode === 'create' ? 'Add skill to changes' : 'Keep changes', function () { saveSkillForm(); }, { class: 'primary' }),
      button('Cancel', function () { closeSkillForm(); }, { class: 'secondary' })));
    return card;
  }

  function saveSkillForm() {
    var form = skillsView().form;
    var label = String(form.label || '').trim();
    var description = String(form.description || '').replace(/\s+/g, ' ').trim();
    var instructions = String(form.instructions || '').trim();
    var id = form.mode === 'create' ? kebab(label) : form.id;
    if (!label || !id) { setStatus('Give the skill a name.'); return; }
    if (form.mode === 'create' && state.draft.skills[id]) { setStatus('A skill called ' + id + ' already exists.'); return; }
    if (!description) { setStatus('Say what the skill does and when to use it.'); return; }
    if (!instructions) { setStatus('Write the instructions the agent follows.'); return; }
    var existing = state.draft.skills[id];
    state.draft.skills[id] = { id: id, label: label, description: description, instructions: instructions, loading: form.loading || 'eager', isNew: existing ? existing.isNew : true };
    var attachTo = form.attachTo && state.draft.workflows[form.attachTo.workflow] ? form.attachTo : null;
    if (attachTo) {
      var back = state.returnTo;
      skillsView().form = null; skillsView().step = null;
      if (back) { state.returnTo = null; state.view = 'board'; state.workflow = back.workflow; state.step = back.step; }
      attachToStep(attachTo.workflow, id, attachTo.phase, String(attachTo.use || '').replace(/\s+/g, ' ').trim());
      return;
    }
    skillsView().form = null;
    setStatus(form.mode === 'create' ? 'Skill ' + label + ' added to your changes.' : 'Skill ' + label + ' changed.');
    changed();
  }

  function askRemoveSkill(id) {
    if (protectedObject('skills', id)) { setStatus('Seeded skill: duplicate the workflow before removing its copy.'); return; }
    var skill = state.draft.skills[id]; var users = skillUsers(id);
    confirmAction('Delete the skill ' + skill.label + '?',
      users.length ? 'It is detached from ' + users.map(function (agentId) { return state.draft.agents[agentId].label; }).join(', ') + ' too. Running Stories keep the text they started with.' : 'No agent uses it.',
      'Delete skill', function () {
        delete state.draft.skills[id];
        users.forEach(function (agentId) { var agent = state.draft.agents[agentId]; agent.skills = (agent.skills || []).filter(function (entry) { return entry.id !== id; }); });
        Object.values(state.draft.workflows).forEach(function (workflow) { workflow.skills = (workflow.skills || []).filter(function (entry) { return entry.id !== id; }); });
        if (skillsView().form && skillsView().form.id === id) skillsView().form = null;
        setStatus('Deleted the skill ' + skill.label + '.'); changed();
      });
  }

  function openAttachForm(skillId, agentId) {
    var view = skillsView();
    var existing = skillId && agentId ? attachmentOf(agentId, skillId) : null;
    view.attach = { skill: skillId || '', agent: agentId || '', phases: existing ? existing.phases.slice() : [], use: existing ? existing.use || '' : '' };
    view.form = null; state.view = 'skills'; render();
  }

  function renderAttachForm(form) {
    var card = el('section', { class: 'studio-card', 'aria-label': 'Attach a skill' });
    card.appendChild(el('h2', { text: 'Attach a skill to an agent' }));
    var skills = Object.keys(state.draft.skills || {}).sort(function (a, b) { return skillLabel(a).localeCompare(skillLabel(b)); }).concat(pendingLibrarySkills());
    var agents = Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); });
    var reset = function () { var existing = form.skill && form.agent ? attachmentOf(form.agent, form.skill) : null; form.phases = existing ? existing.phases.slice() : []; form.use = existing ? existing.use || '' : ''; };
    card.appendChild(el('div', { class: 'grid-2' },
      field('attach-skill', 'Skill', select('attach-skill', [{ value: '', label: 'Choose a skill' }].concat(skills.map(function (id) { return { value: id, label: skillLabel(id) }; })), form.skill, function (value) { form.skill = value; reset(); render(); })),
      field('attach-agent', 'Agent', select('attach-agent', [{ value: '', label: 'Choose an agent' }].concat(agents.map(function (id) { return { value: id, label: state.draft.agents[id].label }; })), form.agent, function (value) { form.agent = value; reset(); render(); }))));
    if (form.agent) {
      var phaseIds = agentSteps(form.agent).length ? agentSteps(form.agent) : Object.keys(state.draft.phases);
      card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'In which of its steps (none chosen: every step it drafts)' }),
        stepChecks('attach-step-', form.phases, phaseIds, function (phases) { form.phases = phases; })));
    }
    card.appendChild(field('attach-use', 'When to use it', textInput('attach-use', form.use, function (value) { form.use = value; }, { placeholder: 'After you write the code, before you publish it' }),
      'Added to the prompt with the skill, so the agent knows when to carry it out. Leave it empty for whenever the step needs it.'));
    if (form.agent) card.appendChild(el('span', { class: 'hint', text: attachmentHint(form.agent) }));
    card.appendChild(el('div', { class: 'studio-row' },
      button('Attach', function () { saveAttach(); }, { class: 'primary' }),
      button('Cancel', function () { skillsView().attach = null; render(); }, { class: 'secondary' })));
    return card;
  }

  function saveAttach() {
    var form = skillsView().attach;
    if (!form.skill) { setStatus('Choose a skill.'); return; }
    if (!form.agent) { setStatus('Choose the agent that uses it.'); return; }
    var current = attachmentOf(form.agent, form.skill);
    if (current && current.origin === 'agent' && protectedObject('agents', form.agent)) { setStatus(skillLabel(form.skill) + ' comes with ' + state.draft.agents[form.agent].label + '. Duplicate the workflow to change it.'); return; }
    var use = String(form.use || '').replace(/\s+/g, ' ').trim();
    if (use.indexOf('|') >= 0) { setStatus('"When to use it" cannot contain "|".'); return; }
    if (use.length > 300) { setStatus('"When to use it" must be at most 300 characters.'); return; }
    var agent = state.draft.agents[form.agent];
    agent.skills = (agent.skills || []).filter(function (entry) { return entry.id !== form.skill; }).concat([{ id: form.skill, phases: form.phases.slice(), use: use, origin: current ? current.origin : undefined }]);
    skillsView().attach = null;
    setStatus(agent.label + ' uses ' + skillLabel(form.skill) + '.');
    changed();
  }

  function detachSkill(agentId, skillId) {
    var entry = attachmentOf(agentId, skillId);
    if (entry && entry.origin === 'agent' && protectedObject('agents', agentId)) { setStatus(skillLabel(skillId) + ' comes with ' + state.draft.agents[agentId].label + '. Duplicate the workflow to change it.'); return; }
    var agent = state.draft.agents[agentId];
    agent.skills = (agent.skills || []).filter(function (entry) { return entry.id !== skillId; });
    setStatus(agent.label + ' no longer uses ' + skillLabel(skillId) + '.');
    changed();
  }

  function renderLibrary(main) {
    var lib = library();
    backLink(main);
    main.appendChild(el('header', null, el('h1', { text: 'Library' }),
      el('p', { class: 'studio-lede', text: 'Add skills, document templates, agents and MCP servers from a link, a marketplace your repository trusts, or an approved MCP server. You see the exact content before it is added; it is copied into your configuration and published with your other changes.' })));
    var form = el('section', { class: 'studio-card', 'aria-label': 'Add from a link' });
    form.appendChild(el('h2', { text: 'Add from a link' }));
    form.appendChild(el('div', { class: 'grid-2' },
      field('import-link', 'Link to the raw file', textInput('import-link', lib.reference, function (value) { lib.reference = value.trim(); }, { placeholder: 'https://example.org/skills/security-review/SKILL.md' })),
      field('import-as', 'Use it as', select('import-as', IMPORT_KINDS, lib.as, function (value) { lib.as = value; }))));
    form.appendChild(el('div', { class: 'studio-row' },
      button(lib.busy === 'preview' ? 'Fetching…' : 'Preview', function () {
        if (!/^https:\/\//.test(lib.reference || '')) { lib.error = 'Paste a public https:// link to the raw file.'; render(); return; }
        lib.replace = false;
        previewImport(lib.reference, lib.as, null);
      }, { class: 'primary', disabled: Boolean(lib.busy) }),
      el('span', { class: 'muted', text: 'Only public HTTPS links; nothing is sent with the request.' })));
    if (lib.error) form.appendChild(el('div', { class: 'callout bad', role: 'alert', text: lib.error }));
    main.appendChild(form);
    if (lib.preview) main.appendChild(renderPreviewCard(lib));
    if (lib.generated) main.appendChild(renderGeneratedForm(lib));
    var queued = (state.draft.imports || []);
    if (queued.length) {
      main.appendChild(el('section', { class: 'studio-card', 'aria-label': 'Waiting to be published' }, el('h2', { text: 'Waiting to be published' }),
        el('ul', { class: 'change-list' }, queued.map(function (change) {
          return el('li', { class: 'studio-row spread' }, el('span', { text: describe(change, state.draft) }),
            button('Undo', function () { state.draft.imports = state.draft.imports.filter(function (entry) { return entry !== change; }); changed(); }, { class: 'secondary', 'aria-label': 'Undo: ' + describe(change, state.draft) }));
        })),
        button('Review changes', function () { state.view = 'changes'; render(); }, { class: 'primary' })));
    }
    main.appendChild(renderMarketplaces(lib));
    main.appendChild(renderMcpSources(lib));
    main.appendChild(renderImported(lib));
  }

  function renderPeople(main) {
    backLink(main);
    main.appendChild(el('header', null, el('h1', { text: 'People & approvals' }), el('p', { class: 'studio-lede', text: 'An approval group is the list of people who may sign off a step. A step can only be approved by someone in its group.' })));
    var grid = el('div', { class: 'groups-grid' });
    Object.keys(state.draft.groups).forEach(function (id) {
      var group = state.draft.groups[id];
      var approves = Object.keys(state.draft.workflows).reduce(function (list, workflowId) { workflowSteps(workflowId).forEach(function (phaseId) { var settings = state.draft.steps[workflowId][phaseId]; if (settings && groupsOf(settings.approval).indexOf(id) >= 0 && list.indexOf(phaseId) < 0) list.push(phaseId); }); return list; }, []);
      var draftPerson = group.adding || (group.adding = { name: '', email: '' });
      var heading = group.renaming != null
        ? el('div', { class: 'studio-row' },
          textInput('group-name-' + id, group.renaming, function (value) { group.renaming = value; }, { 'aria-label': 'New name for ' + group.label }),
          button('Save name', function () {
            var label = String(group.renaming || '').trim();
            if (!label) { setStatus('An approval group needs a name.'); return; }
            group.label = label; group.renaming = null; changed();
          }, { class: 'primary' }),
          button('Cancel', function () { group.renaming = null; render(); }, { class: 'secondary' }))
        : el('div', { class: 'studio-row spread' }, el('strong', { text: group.label }),
          el('div', { class: 'studio-row' }, el('span', { class: 'muted', text: groupHint(group) }),
            button('Rename', function () { group.renaming = group.label; render(); }, { class: 'secondary', 'aria-label': 'Rename ' + group.label }),
            group.isNew ? button('Remove', function () { askRemoveNewGroup(id, approves); }, { class: 'secondary', 'aria-label': 'Remove ' + group.label }) : null));
      grid.appendChild(el('article', { class: 'studio-card', 'aria-label': group.label },
        heading,
        el('span', { class: 'muted', text: approves.length ? 'Signs off: ' + approves.map(function (phaseId) { return (state.draft.phases[phaseId] || { label: phaseId }).label; }).join(', ') : 'Signs off no step yet' }),
        groupBlocked(id) && approves.length ? el('div', { class: 'callout bad', text: 'Nobody can approve these steps until someone is added.' }) : null,
        !group.members.length && group.status === 'auto' ? el('div', { class: 'callout', text: 'Empty: whoever starts a Story is added automatically. Add people here for independent review.' }) : null,
        el('div', { class: 'rail' }, group.members.map(function (member, index) {
          var name = member.name || member.email || member.githubLogin;
          return el('span', { class: 'member' }, name, button('Remove', function () { group.members.splice(index, 1); changed(); }, { class: 'secondary', 'aria-label': 'Remove ' + name, title: 'Remove' }));
        })),
        el('div', { class: 'grid-3' },
          textInput('person-name-' + id, draftPerson.name, function (value) { draftPerson.name = value; }, { placeholder: 'Name', 'aria-label': 'Name' }),
          textInput('person-mail-' + id, draftPerson.email, function (value) { draftPerson.email = value; }, { placeholder: 'Email or GitHub login', 'aria-label': 'Email or GitHub login' }),
          button('Add', function () {
            var contact = String(draftPerson.email || '').trim();
            if (!contact) { setStatus('Give an email address or a GitHub login.'); return; }
            var member = contact.indexOf('@') > 0 ? { name: draftPerson.name.trim() || null, email: contact.toLowerCase(), githubLogin: null } : { name: draftPerson.name.trim() || null, email: null, githubLogin: contact.toLowerCase() };
            if (group.members.some(function (existing) { return (member.email && existing.email === member.email) || (member.githubLogin && existing.githubLogin === member.githubLogin); })) { setStatus(contact + ' is already in ' + group.label + '.'); return; }
            group.members.push(member); group.adding = { name: '', email: '' }; changed();
          }, { 'aria-label': 'Add person to ' + group.label }))));
    });
    main.appendChild(grid);
    var adding = state.newGroup || (state.newGroup = { label: '' });
    function askRemoveNewGroup(groupId, approves) {
      var group = state.draft.groups[groupId];
      if (approves.length) { setStatus('Choose another sign-off group for ' + approves.map(stepLabel).join(', ') + ' first.'); return; }
      confirmAction('Remove the new approval group ' + group.label + '?', 'It has not been published, so nothing else changes.', 'Remove group', function () {
        delete state.draft.groups[groupId]; setStatus('Removed the new approval group ' + group.label + '.'); changed();
      });
    }
    main.appendChild(el('div', { class: 'studio-row' }, textInput('new-group', adding.label, function (value) { adding.label = value; }, { placeholder: 'New approval group name', 'aria-label': 'New approval group name' }),
      button('New approval group', function () {
        var id = kebab(adding.label);
        if (!id || state.draft.groups[id]) { setStatus('Choose a different group name.'); return; }
        state.draft.groups[id] = { id: id, label: adding.label.trim(), members: [], status: 'blocked', isNew: true };
        adding.label = ''; changed();
      })));
  }

  function renderChanges(main) {
    var changeSet = changeSetFrom(state.model, state.draft);
    var key = JSON.stringify(changeSet);
    main.appendChild(el('header', null, el('h1', { text: changeSet.changes.length ? changeSet.changes.length + (changeSet.changes.length === 1 ? ' change ready' : ' changes ready') : 'No changes yet' }),
      el('p', { class: 'studio-lede', text: 'Changes are published together as one change, so nothing is ever half-applied. Check them first; Singularity Flow validates the whole configuration.' })));
    if (!changeSet.changes.length) { main.appendChild(el('p', { class: 'muted', text: 'Edit a workflow, an agent or an approval group and your changes collect here.' })); renderProposals(main); return; }
    main.appendChild(el('ol', { class: 'change-list' }, changeSet.changes.map(function (change) { return el('li', { text: describe(change, state.draft) }); })));
    var fresh = state.plan && state.planKey === key;
    main.appendChild(el('div', { class: 'studio-row' },
      button(state.busy === 'check' ? 'Checking…' : 'Check changes', function () { state.busy = 'check'; render(); post({ type: 'studio.preview', changeSet: key }); }, { class: fresh && state.plan.valid ? 'secondary' : 'primary', disabled: Boolean(state.busy) }),
      button(state.busy === 'publish' ? 'Publishing…' : publishLabel(), function () { state.busy = 'publish'; render(); post({ type: 'studio.publish', changeSet: key, count: changeSet.changes.length }); }, { class: fresh && state.plan.valid ? 'primary' : 'secondary', disabled: !fresh || !state.plan.valid || Boolean(state.busy) }),
      button('Discard all changes', function () {
        var count = changeSet.changes.length;
        var listed = changeSet.changes.slice(0, 6).map(function (change) { return describe(change, state.draft); });
        confirmAction('Discard ' + count + (count === 1 ? ' unpublished change?' : ' unpublished changes?'),
          'Everything changed in Workflow Studio since the last publish is lost: ' + listed.join('; ') + (count > listed.length ? '; and ' + (count - listed.length) + ' more' : '') + '.',
          'Discard changes', discardDraft);
      }, { class: 'secondary', disabled: Boolean(state.busy) })));
    if (state.plan && !fresh) main.appendChild(el('p', { class: 'muted', text: 'You changed something since the last check. Check again before publishing.' }));
    if (fresh) main.appendChild(renderPlan(state.plan));
    renderProposals(main);
  }

  // ---- Configuration proposals waiting for review ---------------------------------------------
  //
  // Every governed configuration change waits as a proposal until someone activates it: what Studio
  // publishes, an imported bundle, a Configuration Center or agent save. Reviewing opens the exact
  // diff; activating merges it into the approved configuration after the person confirms.

  function proposalsState() { return state.proposals || (state.proposals = { list: null, error: null, loading: false, local: false }); }
  function requestProposals() {
    var view = proposalsState();
    if (view.loading) return;
    view.loading = true; view.error = null;
    post({ type: 'studio.proposals' });
  }
  function reviewProposal(branch) {
    state.reviewing = branch; state.busy = 'review'; setStatus('Opening ' + branch + ' for review…'); render();
    post({ type: 'studio.reviewProposal', branch: branch, pending: changesNow().length });
  }
  function renderProposals(main) {
    var view = proposalsState();
    var card = el('section', { class: 'studio-card', 'aria-label': 'Waiting for review' });
    card.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Waiting for review' }),
      view.local ? null : button(view.loading ? 'Looking…' : 'Refresh', requestProposals, { class: 'secondary', disabled: view.loading })));
    if (view.local) {
      card.appendChild(el('p', { class: 'muted', text: 'This repository keeps its configuration in its working tree, so changes are reviewed as commits rather than proposals.' }));
      main.appendChild(card); return;
    }
    if (view.error) card.appendChild(el('div', { class: 'callout bad', text: view.error }));
    if (view.list === null) { if (!view.error) card.appendChild(el('p', { class: 'muted', text: 'Looking for configuration proposals…' })); }
    else if (!view.list.length) card.appendChild(el('p', { class: 'muted', text: 'No configuration proposals are waiting.' }));
    (view.list || []).forEach(function (proposal) {
      var subjects = proposal.workflows.map(function (workflow) { return (workflow.label || workflow.id) + ' (' + workflow.change + ')'; });
      card.appendChild(el('article', { class: 'decision-box', 'aria-label': 'Proposal ' + proposal.branch },
        el('div', { class: 'studio-row spread' },
          el('div', null, el('code', { text: proposal.branch }), el('span', { class: 'muted', text: '  ' + proposal.proposalCommit.slice(0, 12) })),
          proposal.valid && !proposal.merged
            ? button(state.busy === 'review' ? 'Reviewing…' : 'Review and activate', function () { reviewProposal(proposal.branch); }, { class: 'primary', disabled: Boolean(state.busy), 'aria-label': 'Review and activate ' + proposal.branch })
            : el('span', { class: 'pill', text: proposal.merged ? 'Merged' : 'Blocked' })),
        el('span', { class: 'muted', text: (subjects.length ? subjects.join(', ') : 'Configuration-only change') + ' · ' + proposal.files + (proposal.files === 1 ? ' file' : ' files') }),
        proposal.failure ? el('div', { class: 'callout bad', text: proposal.failure }) : null,
        proposal.invalidFiles.length ? el('div', { class: 'callout bad', text: 'Not configuration: ' + proposal.invalidFiles.join(', ') }) : null));
    });
    card.appendChild(el('p', { class: 'muted', text: 'Reviewing opens the exact diff; activating merges it into the approved configuration after you confirm. Running Stories keep the configuration they started with.' }));
    main.appendChild(card);
  }

  // ---- Workflow bundles ---------------------------------------------------------------------------

  function renderExport() {
    var chosen = state.exporting;
    var published = state.draft.order.filter(function (id) { var workflow = state.draft.workflows[id]; return workflow && !workflow.isNew && !workflow.installFrom; })
      .map(function (id) { return { key: id, selector: 'story:' + id, workflow: state.draft.workflows[id], governs: 'Story' }; });
    if (state.draft.epics) Object.keys(state.draft.epics.workflows).filter(function (id) { return !state.draft.epics.workflows[id].isNew; })
      .forEach(function (id) { published.push({ key: 'initiative:' + id, selector: 'initiative:' + id, workflow: state.draft.epics.workflows[id], governs: 'Epic' }); });
    var card = el('section', { class: 'studio-card', 'aria-label': 'Export workflows' });
    card.appendChild(el('h2', { text: 'Export workflows' }));
    card.appendChild(el('p', { class: 'muted', text: 'A bundle carries the workflows and everything they need (steps, templates, artifact sets and agents), so another repository can import them as one reviewed proposal. Only published workflows are exported.' }));
    card.appendChild(el('div', { class: 'checks' }, published.map(function (entry) {
      var workflow = entry.workflow, id = entry.key;
      return el('label', null, el('input', { type: 'checkbox', 'data-key': 'export-' + id, checked: Boolean(chosen[id]), onchange: function (event) { if (event.target.checked) chosen[id] = true; else delete chosen[id]; render(); } }),
        ' ' + workflow.label + ' ', el('span', { class: 'muted', text: entry.governs + ' · ' + workflow.phases.length + (workflow.phases.length === 1 ? ' step' : ' steps') }));
    })));
    var selected = published.filter(function (entry) { return chosen[entry.key]; });
    card.appendChild(el('div', { class: 'studio-row' },
      button('Select all', function () { published.forEach(function (entry) { chosen[entry.key] = true; }); render(); }, { class: 'secondary' }),
      button('Clear', function () { published.forEach(function (entry) { delete chosen[entry.key]; }); render(); }, { class: 'secondary' }),
      button(state.busy === 'export' ? 'Exporting…' : 'Save bundle…', function () {
        state.busy = 'export'; render();
        post({ type: 'studio.exportWorkflows', workflowIds: selected.map(function (entry) { return entry.selector; }) });
      }, { class: 'primary', disabled: !selected.length || Boolean(state.busy) }),
      button('Cancel', function () { state.exporting = null; render(); }, { class: 'secondary' })));
    return card;
  }
  function importWorkflows() {
    state.busy = 'import'; setStatus('Choose a workflow bundle to import…'); render();
    post({ type: 'studio.importWorkflows', pending: changesNow().length });
  }
  function protectedObject(kind, id) { return Boolean(state.model && state.model.protection && (state.model.protection[kind] || []).indexOf(id) >= 0); }
  function duplicateWorkflow(selector) {
    state.busy = 'import'; setStatus('Review the workflow dependencies and destination identities…'); render();
    post({ type: 'studio.duplicateWorkflow', selector: selector, pending: changesNow().length });
  }
  function renderSeededWorkflow(main, workflow, governs) {
    main.appendChild(el('header', null, el('h1', { text: workflow.label }),
      el('p', { class: 'studio-lede', text: 'Seeded workflow · read-only. Its steps can still use skills from the skill master: they are kept in ' + attachmentsPath() + ', so the framework workflow and its agents stay as they shipped. Duplicate it to customize steps, agents and templates.' })));
    main.appendChild(el('div', { class: 'studio-row' },
      button('← Workflows', function () { state.view = 'home'; render(); }, { class: 'secondary' }),
      button('Duplicate and customize', function () { duplicateWorkflow(governs + ':' + workflow.id); }, { class: 'primary' })));
    main.appendChild(el('ol', { class: 'seeded-steps' }, workflow.phases.map(function (id) {
      var phase = governs === 'story' ? state.draft.phases[id] : state.draft.epics.steps[id];
      var agentId = phase && phase.agent;
      var agent = agentId ? state.draft.agents[agentId] : null;
      if (governs !== 'story' || !agent) return el('li', null, el('strong', { text: phase ? phase.label : id }), el('span', { class: 'muted', text: phase && phase.agent ? ' · ' + phase.agent : '' }));
      var skills = stepSkillEntries(agentId, id, workflow.id);
      var open = state.seededSkills === id;
      return el('li', null,
        el('div', { class: 'studio-row spread' },
          el('span', null, el('strong', { text: phase.label }), el('span', { class: 'muted', text: ' · ' + agent.label + (skills.length ? ' · skills: ' + skills.map(function (entry) { return skillLabel(entry.id); }).join(', ') : '') })),
          button(open ? 'Done' : 'Skills', function () { state.seededSkills = open ? null : id; state.step = id; render(); }, { class: 'secondary', 'aria-expanded': open ? 'true' : 'false', 'aria-label': 'Skills for ' + phase.label, 'data-key': 'seeded-skills-' + id })),
        open ? el('div', { class: 'studio-card', 'aria-label': 'Skills for ' + phase.label }, stepSkillsBody(id, agentId, 'seeded-skill-' + id + '-')) : null);
    })));
  }
  /** Open a governed file in an editor: the workflow file, or a template under the templates folder. */
  function openFile(relative) { post({ type: 'studio.openFile', path: relative }); }
  function templateFilePath(relative) { return (state.model.templatesRoot || 'singularity/templates') + '/' + relative; }

  /** Back to the published configuration: the draft, and every form still holding typed input. */
  function discardDraft() {
    state.draft = initialDraft(state.model); state.plan = null; state.planKey = null;
    state.adding = null; state.wizard = null; state.agentForm = null; state.newGroup = null; state.returnTo = null;
    state.panel = null; state.decision = null; state.workflow = null; state.step = null;
    state.epicForm = null; state.epicOutput = null; state.epicAdding = null; state.epic = null; state.epicStep = null;
    if (state.integrations) state.integrations.form = null;
    if (state.library) { state.library.preview = null; state.library.target = null; state.library.replace = false; state.library.error = null; }
    post({ type: 'studio.draftClear' });
    state.view = 'home'; setStatus('Discarded every unpublished change.'); render();
  }

  function publishLabel() {
    var kind = state.model.authority && state.model.authority.kind;
    return kind && kind !== 'working-tree' ? 'Publish for review' : 'Write to this repository';
  }

  function renderPlan(plan) {
    var section = el('section', { class: 'studio-card', 'aria-label': 'Check result' });
    section.appendChild(el('h2', { text: plan.valid ? 'Checked: ready to publish' : 'Checked: fix these first' }));
    plan.problems.forEach(function (problem) { section.appendChild(el('div', { class: 'callout bad', text: problem.message })); });
    plan.warnings.forEach(function (warning) { section.appendChild(el('div', { class: 'callout wait', text: warning.message })); });
    if (plan.valid) plan.summary.forEach(function (line) { section.appendChild(el('div', { class: 'callout ok', text: line })); });
    if (plan.files.length) {
      var files = el('details', null, el('summary', { text: 'Files this changes (' + plan.files.length + ')' }));
      plan.files.forEach(function (file) {
        files.appendChild(el('div', { style: 'margin-top:8px' }, el('code', { text: file.path }), el('span', { class: 'muted', text: file.action === 'create' ? '  new' : '  changed' })));
        var pre = el('pre', { class: 'diff' });
        String(file.diff || '').split('\n').forEach(function (line) { pre.appendChild(el('span', { class: line.charAt(0) === '+' && line.slice(0, 3) !== '+++' ? 'add' : line.charAt(0) === '-' && line.slice(0, 3) !== '---' ? 'del' : null, text: line + '\n' })); });
        files.appendChild(pre);
      });
      section.appendChild(files);
    }
    var kind = state.model.authority && state.model.authority.kind;
    section.appendChild(el('p', { class: 'muted', text: kind && kind !== 'working-tree'
      ? 'Publishing opens one review proposal on the approved configuration. Approved configuration and running Stories stay as they are until it is merged.'
      : 'Publishing writes these files to this repository. Review the diff and commit it through your usual review.' }));
    return section;
  }

  // ---- Frame ---------------------------------------------------------------------------------

  function render() {
    var root = document.getElementById('studio-root');
    if (!root) return;
    // A control can ask for focus after the render it causes (the next step on the canvas, a field it opens).
    var active = state.focusKey || (document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-key') : null);
    state.focusKey = null;
    root.textContent = '';
    if (state.error && !state.model) { root.appendChild(el('div', { class: 'studio-main' }, el('h1', { text: 'Workflow Studio could not load' }), el('p', { class: 'callout bad', text: state.error }), button('Try again', function () { state.error = null; post({ type: 'studio.reload' }); }))); return; }
    if (!state.model) { root.appendChild(el('div', { class: 'studio-main' }, el('p', { text: 'Loading workflows, steps and agents…' }))); return; }
    var frame = el('div', { class: 'studio' + (state.view === 'board' ? ' compact' : '') });
    renderNav(frame);
    var main = el('main', { class: 'studio-main' + (state.view === 'board' ? ' board-main' : '') });
    (state.model.problems || []).forEach(function (problem) { main.appendChild(el('div', { class: 'callout bad', text: 'The current configuration has a problem: ' + problem.message })); });
    if (state.restorable) {
      var when = state.restorable.savedAt ? new Date(state.restorable.savedAt) : null;
      main.appendChild(el('div', { class: 'callout wait', role: 'status' },
        el('div', { text: 'Unpublished changes were kept when Workflow Studio closed' + (when && !isNaN(when.getTime()) ? ' (' + when.toLocaleString() + ')' : '') + '.' }),
        el('div', { class: 'studio-row', style: 'margin-top:6px' },
          button('Restore them', function () { state.draft = withDraftDefaults(state.restorable.draft); state.restorable = null; state.view = 'changes'; changed(); }, { class: 'primary', 'data-key': 'draft-restore' }),
          button('Discard them', function () { state.restorable = null; post({ type: 'studio.draftClear' }); render(); }, { class: 'secondary', 'data-key': 'draft-discard' }))));
    }
    if (state.configurationChanged) {
      main.appendChild(el('div', { class: 'callout wait', role: 'status' },
        el('div', { text: 'The approved configuration changed (' + state.configurationChanged + '). Your unpublished changes were made on the earlier version, so Check refuses them until you reload; reloading discards them.' }),
        el('div', { class: 'studio-row', style: 'margin-top:6px' }, button('Reload and discard my changes', function () { post({ type: 'studio.draftClear' }); post({ type: 'studio.reload' }); }, { class: 'secondary', 'data-key': 'configuration-reload' }))));
    }
    if (state.view === 'changes' && proposalsState().list === null && !proposalsState().loading && !proposalsState().error) requestProposals();
    if (state.view === 'board') renderBoard(main);
    else if (state.view === 'new') renderWizard(main);
    else if (state.view === 'agents') renderAgents(main);
    else if (state.view === 'artifacts') renderArtifacts(main);
    else if (state.view === 'epic') renderEpic(main);
    else if (state.view === 'skills') renderSkills(main);
    else if (state.view === 'library') renderLibrary(main);
    else if (state.view === 'people') renderPeople(main);
    else if (state.view === 'integrations') renderIntegrations(main);
    else if (state.view === 'changes') renderChanges(main);
    else renderHome(main);
    if (state.view !== 'board') main.appendChild(el('div', { id: 'studio-status', class: 'studio-status', role: 'status', 'aria-live': 'polite', text: state.status }));
    frame.appendChild(main);
    root.appendChild(frame);
    if (state.view === 'board') fitBoard();
    if (active) { var again = root.querySelector('[data-key="' + active.replace(/"/g, '') + '"]'); if (again) again.focus(); }
  }

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    if (message.type === 'studio.model') {
      var keep = state.draft && state.model && changeSetFrom(state.model, state.draft).changes.length && !message.reset;
      state.model = message.model; state.error = null;
      if (!keep) { state.draft = initialDraft(message.model); state.configurationChanged = null; }
      if (state.workflow && !state.draft.workflows[state.workflow]) state.workflow = null;
      // Whether this machine has the secrets the targets name decides the Integrations badge.
      askSecretStatus(targetIds().reduce(function (names, id) { return names.concat(targetSecrets(state.draft.integrations[id])); }, []));
      state.busy = null; render();
    } else if (message.type === 'studio.plan') {
      state.plan = message.plan; state.planKey = message.changeSet; state.busy = null;
      setStatus(message.plan.valid ? 'Checked: ready to publish.' : 'Checked: some changes need fixing.');
      render();
    } else if (message.type === 'studio.published') {
      // What was just published is a proposal the list has not seen yet.
      if (state.proposals) { state.proposals.list = null; state.proposals.error = null; }
      state.busy = null; state.plan = null; state.planKey = null; state.view = 'home';
      setStatus(message.summary || 'Published.');
    } else if (message.type === 'studio.proposals') {
      var listed = proposalsState();
      listed.loading = false; listed.list = message.proposals || []; listed.error = message.error || null; listed.local = Boolean(message.local);
      // The list after a review says what became of the proposal: activated (or closed), or still waiting.
      if (state.reviewing) {
        var waiting = listed.list.some(function (proposal) { return proposal.branch === state.reviewing; });
        setStatus(waiting ? state.reviewing + ' is still waiting for review.' : state.reviewing + ' is no longer waiting: it was activated.');
        state.reviewing = null;
      }
      if (state.busy === 'review') state.busy = null;
      render();
    } else if (message.type === 'studio.configurationChanged') {
      state.busy = null; state.configurationChanged = message.reason || 'the approved configuration changed'; render();
    } else if (message.type === 'studio.exported') {
      state.busy = null; state.exporting = null; setStatus('Exported the bundle.'); render();
    } else if (message.type === 'studio.importDone') {
      state.busy = null;
      setStatus(message.outcome === 'cancelled' ? 'Import cancelled; nothing changed.'
        : message.outcome === 'proposed' ? 'The import ' + (message.error ? 'was proposed as ' + message.branch + ', but its review stopped: ' + message.error : 'is waiting for review as ' + message.branch + ', under Changes.')
          : message.outcome === 'written' ? 'The import was written to this repository; review the diff and commit it.'
            : 'The configuration already has everything in that bundle; nothing changed.');
      render();
    } else if (message.type === 'studio.focus') {
      if (typeof message.workflowId === 'string') openWorkflowCanvas(message.workflowId);
      else if (['home', 'agents', 'skills', 'artifacts', 'library', 'people', 'integrations', 'changes'].indexOf(message.view) >= 0) { state.view = message.view; state.returnTo = null; render(); }
    } else if (message.type === 'studio.failed') {
      state.busy = null; state.reviewing = null; setStatus(message.message || 'That did not work.'); if (!state.model) state.error = message.message; render();
    } else if (message.type === 'studio.cancelled') {
      state.busy = null; render();
    } else if (message.type === 'studio.savedDraft') {
      var kept = restorableDraft(message.draft);
      if (kept && !changesNow().length) { state.restorable = { draft: kept, savedAt: message.savedAt || null }; render(); }
    } else if (message.type === 'studio.confirmed') {
      var confirmed = state.confirms[message.id];
      delete state.confirms[message.id];
      if (confirmed && message.ok === true) confirmed();
    } else if (message.type === 'studio.importPreviewed') {
      var lib = library(); lib.busy = null; lib.error = null; lib.preview = message.preview;
      if (!lib.target && lib.pendingAgent) lib.target = { agent: lib.pendingAgent, id: suggestedId(message.preview), phases: (message.preview.marketplace && message.preview.marketplace.phases) || [], optional: false, label: '', withoutDefaults: false };
      lib.pendingAgent = null; render();
    } else if (message.type === 'studio.marketplaceEntries') {
      var market = library(); market.busy = null; market.entries = message.result; market.search = ''; render();
    } else if (message.type === 'studio.importsChecked') {
      var checks = library(); checks.busy = null; checks.check = (message.result && message.result.imports) || [];
      setStatus(checks.check.some(function (entry) { return entry.updateCommand; }) ? 'Some imports changed at their source.' : 'Every import matches its source.'); render();
    } else if (message.type === 'studio.mcpSourcesListed') {
      var offered = library(); offered.busy = null; offered.mcp = message.result; offered.mcpForms = {}; render();
    } else if (message.type === 'studio.secretStatus') {
      var secretView = integrationsState(); secretView.canStore = message.canStore !== false;
      if (message.jira) secretView.jira = message.jira;
      Object.keys(message.status || {}).forEach(function (name) { secretView.secrets[name] = message.status[name]; });
      render();
    } else if (message.type === 'studio.secretStored') {
      setStatus(message.name + ' is stored in the keychain on this machine.');
    } else if (message.type === 'studio.integrationTested') {
      var tested = integrationsState().tests[message.target];
      if (tested) { tested.busy = null; tested.failed = message.failed || null; if (!message.cancelled) tested.result = message.result || null; }
      render();
    } else if (message.type === 'studio.mcpHostAdded') {
      setStatus(message.summary || 'Host entry added.');
    } else if (message.type === 'studio.importFailed') {
      var failed = library(); failed.busy = null; failed.error = message.message || 'That did not work.'; failed.preview = null; render();
      var alert = document.querySelector('[role=alert]'); if (alert && alert.scrollIntoView) alert.scrollIntoView({ block: 'center' });
    }
  });

  if (document.getElementById('studio-root')) {
    var resizing = null;
    window.addEventListener('resize', function () {
      if (state.view !== 'board') return;
      fitBoard(); clearTimeout(resizing);
      resizing = setTimeout(function () { if (state.view === 'board' && state.wrap !== false) rewrap(); }, 250);
    });
    document.addEventListener('pointerdown', function () { pointerDown = true; }, true);
    window.addEventListener('click', function () { setTimeout(flushRender, 0); });
    document.addEventListener('pointerup', function () { setTimeout(function () { if (pointerDown) flushRender(); }, 120); }, true);
    render();
    post({ type: 'studio.ready' });
  }
})();
`;

// The commands the host runs for this page. Here rather than in the host so they can be checked
// without the VS Code runtime.

/** The configuration authority the Studio's model was read from, as the engine reported it. */
export interface StudioAuthority {
  kind?: string | null;
  commit?: string | null;
  remoteFingerprint?: string | null;
  sourceCommit?: string | null;
}

/**
 * The publish command for the authority the model came from. An externally governed configuration
 * is changed through one review proposal bound to the exact authority revision the Studio read; a
 * working-tree authority is written directly; a recovery mirror is read-only.
 */
export function studioPublishArgs(authority: StudioAuthority | null | undefined): string[] {
  const kind = authority?.kind ?? 'working-tree';
  if (kind === 'verified-state-mirror') {
    throw new Error('This configuration is readable only from the verified state recovery mirror. Restore or reinitialize sflow/config before editing it.');
  }
  const base = ['workflow', 'studio', 'apply', '--change-set', '-'];
  if (kind === 'working-tree') return [...base, '--json'];
  return [
    ...base, '--propose',
    '--expected-authority-kind', kind,
    ...(authority?.commit ? ['--expected-authority-commit', authority.commit] : []),
    ...(authority?.remoteFingerprint ? ['--expected-authority-remote-fingerprint', authority.remoteFingerprint] : []),
    ...(authority?.sourceCommit ? ['--expected-authority-source-commit', authority.sourceCommit] : []),
    '--json'
  ];
}

export const STUDIO_PREVIEW_ARGS = Object.freeze(['workflow', 'studio', 'apply', '--change-set', '-', '--dry-run', '--json']);
export const STUDIO_MODEL_ARGS = Object.freeze(['workflow', 'studio', '--json']);

/**
 * The page body. The panel wraps it in the shared page shell, so the footer that shell draws and
 * the code that answers the footer's clicks live in the same file.
 */
export function workflowStudioBody(token: string): string {
  return `<style nonce="${token}">${STUDIO_STYLE}</style><div id="studio-root" class="studio-shell"></div>`;
}
