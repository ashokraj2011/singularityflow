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
.board{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:var(--sf-space-3);height:calc(100vh - 250px);min-height:420px}
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
.node{position:absolute;box-sizing:border-box;border-radius:12px;border:1px solid color-mix(in srgb,var(--tone) 55%,transparent);background:linear-gradient(180deg,color-mix(in srgb,var(--tone) 20%,var(--vscode-editor-background)),color-mix(in srgb,var(--tone) 7%,var(--vscode-editor-background)));box-shadow:0 2px 10px rgba(0,0,0,.22)}
.node:hover{border-color:var(--tone)}
.node.selected{border:2px solid var(--tone);box-shadow:0 0 0 4px color-mix(in srgb,var(--tone) 28%,transparent),0 6px 18px rgba(0,0,0,.3)}
.node.match{box-shadow:0 0 0 4px var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33))}
.node.dragging{opacity:.45}
.node.drop-target{outline:2px dashed var(--sf-accent);outline-offset:4px}
.node.blocked{border-color:var(--sf-bad)}
.node-main{display:flex;flex-direction:column;gap:6px;width:100%;height:100%;box-sizing:border-box;padding:10px 12px;border:0;border-radius:inherit;background:transparent;color:var(--vscode-foreground);font:inherit;text-align:left;cursor:pointer}
.node-main:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
.node-head{display:flex;align-items:center;gap:8px}
.node-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:8px;background:color-mix(in srgb,var(--tone) 28%,transparent);color:var(--tone)}
.node-step{font-size:10px;letter-spacing:1px;font-weight:700;opacity:.75;flex:1 0 auto;white-space:nowrap}
.node-title{font-size:13px;font-weight:600;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.node-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;border-top:1px solid color-mix(in srgb,var(--tone) 30%,transparent);padding-top:6px}
.node-agent{display:inline-flex;align-items:center;gap:6px;min-width:0}
.node-agent .name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.node-sign{display:inline-flex;align-items:center;gap:3px;flex:none;padding:1px 6px;border-radius:9px;background:color-mix(in srgb,var(--vscode-foreground) 14%,transparent)}
.node-sign.none{background:transparent;opacity:.7}
.node-sign.bad{background:var(--sf-bad);color:var(--vscode-editor-background)}
.node-tools{position:absolute;top:-31px;right:10px;display:none;gap:2px;padding:2px;border-radius:8px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 2px 6px rgba(0,0,0,.25)}
.node:hover .node-tools,.node:focus-within .node-tools,.node.selected .node-tools{display:flex}
.node-tools button,.zoom-controls button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.node-tools button:disabled{opacity:.35;cursor:default}
.finish{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;border-radius:18px;border:1px dashed var(--sf-border-color);background:var(--sf-surface);font-size:12px;font-weight:600}
.diamond-node{position:absolute;box-sizing:border-box;width:22px;height:22px;margin:-11px 0 0 -11px;padding:0;transform:rotate(45deg);border-radius:4px;border:2px solid var(--vscode-charts-purple,#b180d7);background:color-mix(in srgb,var(--vscode-charts-purple,#b180d7) 30%,var(--vscode-editor-background));cursor:pointer}
.diamond-node[aria-pressed=true]{box-shadow:0 0 0 4px color-mix(in srgb,var(--vscode-charts-purple,#b180d7) 35%,transparent)}
.diamond-caption{position:absolute;transform:translateX(-50%);width:88px;font-size:10px;line-height:1.25;text-align:center;opacity:.9;pointer-events:none}
.edge-label{position:absolute;transform:translate(-50%,-50%);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;font-size:10.5px;padding:2px 8px;border-radius:10px;border:1px solid var(--tone);background:var(--vscode-editor-background);color:var(--vscode-foreground);cursor:pointer}
.edge-label.tone-send-back{--tone:var(--vscode-charts-orange,#d18616)}
.edge-label.tone-decision{--tone:var(--vscode-charts-purple,#b180d7)}
.tool-rail{position:absolute;left:10px;top:10px;z-index:2;display:flex;flex-direction:column;gap:4px;padding:5px;border-radius:10px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 2px 10px rgba(0,0,0,.22)}
.tool{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer}
.tool[aria-pressed=true]{background:var(--sf-accent-quiet);color:var(--sf-accent)}
.tool:disabled{opacity:.35;cursor:default}
.zoom-controls{position:absolute;right:10px;bottom:10px;z-index:2;display:flex;align-items:center;gap:2px;padding:3px;border-radius:9px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 2px 10px rgba(0,0,0,.22)}
.zoom-level{min-width:42px;text-align:center;font-size:11px;font-variant-numeric:tabular-nums}
.canvas-legend{position:absolute;left:12px;bottom:12px;z-index:1;max-width:calc(100% - 210px);display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;opacity:.85;pointer-events:none}
.legend{display:inline-flex;align-items:center;gap:5px}
.legend-dot{width:9px;height:9px;border-radius:3px;background:var(--tone)}
.legend-dot.diamond-dot{transform:rotate(45deg);border-radius:2px}
.legend-line{width:16px;height:0;border-top:2px solid var(--tone)}
.legend.hint-text{opacity:.75;font-style:italic}
.find-box{position:absolute;left:62px;top:10px;z-index:2;display:flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;border-radius:9px;border:1px solid var(--sf-border-color);background:var(--sf-surface);box-shadow:0 2px 10px rgba(0,0,0,.22)}
.find-box input{font:inherit;width:200px;padding:4px 6px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border-color));background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
.board .inspector{position:static;overflow-y:auto;min-height:0}
.inspector.properties{padding:0;gap:0;background:var(--sf-surface)}
.prop-title{display:flex;align-items:center;gap:10px;padding:var(--sf-space-3);border-bottom:1px solid var(--sf-border-color)}
.prop-title h2{font-size:14px;margin:2px 0 0}
.prop-section{border-bottom:1px solid var(--sf-border-color)}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px var(--sf-space-3)}
.section-toggle{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:2px 0;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;font-size:12px;text-align:left;cursor:pointer}
.section-toggle .summary{font-weight:400;opacity:.7;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
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
.field input[type=text],.field input[type=email],.field select,.field textarea{font:inherit;padding:6px 8px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border-color));background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
.field textarea{min-height:110px;resize:vertical}
.field .hint{font-size:11px;opacity:.8;line-height:1.4}
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
.change-list li{border:1px solid var(--sf-border-color);border-radius:8px;padding:8px 10px;font-size:13px}
.diff{font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre;overflow:auto;max-height:320px;border:1px solid var(--sf-border-color);border-radius:6px;padding:8px;margin:0}
.diff .add{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.diff .del{color:var(--vscode-gitDecoration-deletedResourceForeground,#c74e39)}
.studio-status{min-height:1.2em;font-size:12px}
.decision-box{border:1px solid var(--sf-border-color);border-radius:8px;padding:8px 10px;margin:0;display:flex;flex-direction:column;gap:6px}
.decision-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.preview-text{font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre-wrap;overflow:auto;max-height:280px;border:1px solid var(--sf-border-color);border-radius:6px;padding:8px;margin:0}
.decision-row select,.decision-row input[type=text]{font:inherit;padding:4px 6px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border-color));background:var(--vscode-input-background);color:var(--vscode-input-foreground);max-width:100%}
@media (max-width:900px){.studio,.studio.compact{grid-template-columns:minmax(0,1fr)}.studio-nav,.studio.compact .studio-nav{border-right:0;border-bottom:1px solid var(--sf-border-color);flex-direction:row;flex-wrap:wrap}.studio-nav .note{display:none}.board{grid-template-columns:minmax(0,1fr);height:auto}.canvas{height:420px}.inspector{position:static}}
`;

/**
 * The page's logic. Plain browser JavaScript: it renders with DOM calls (text is never parsed as
 * HTML), keeps the draft, and exposes its pure parts on `window.__workflowStudio` so they can be
 * exercised without a browser.
 */
export const WORKFLOW_STUDIO_SCRIPT = String.raw`
(function () {
  'use strict';
  var vscodeApi = window.__sfVscode;
  var state = { model: null, draft: null, view: 'home', workflow: null, step: null, decision: null, plan: null, planKey: null, busy: null, error: null, wizard: null, agentForm: null, status: '', panel: null, sections: {}, canvas: {}, focusKey: null };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function kebab(text) { return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
  function initials(label) { var parts = String(label || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/); return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '?')[1] || '')).toUpperCase(); }

  // ---- The draft and the change set ---------------------------------------------------------

  function initialDraft(model) {
    var draft = { workflows: {}, steps: {}, phases: {}, agents: {}, groups: {}, order: [], imports: [] };
    (model.workflows || []).forEach(function (workflow) {
      draft.order.push(workflow.id);
      draft.workflows[workflow.id] = { id: workflow.id, label: workflow.label, description: workflow.description || '', phases: workflow.phases.slice(), reworkLoops: clone(workflow.reworkLoops || []), decisions: clone(workflow.decisions || []), isNew: false, installFrom: null };
      draft.steps[workflow.id] = {};
      (workflow.steps || []).forEach(function (step) {
        draft.steps[workflow.id][step.id] = { approval: step.approval && step.approval.mode !== 'none' ? { group: step.approval.authorities[0] || null, minimum: step.approval.minimum || 1 } : { group: null, minimum: 1 }, inputs: (step.inputs || []).slice(), output: step.output, views: (step.views || []).slice(), clarification: step.clarification || 'off', overridden: Boolean(step.overridden), authoringSkill: step.authoringSkill || null, authoringSkillSetByWorkflow: Boolean(step.authoringSkillSetByWorkflow) };
      });
    });
    (model.phases || []).forEach(function (phase) {
      draft.phases[phase.id] = { id: phase.id, label: phase.label, output: phase.output, baseOutput: phase.output, views: (phase.views || []).slice(), clarification: phase.clarification || 'off', agent: phase.agent, authoringSkill: phase.authoringSkill || null, usedBy: (phase.usedBy || []).slice(), isNew: false, fromBlueprint: null, approval: phase.approval && phase.approval.mode !== 'none' ? { group: phase.approval.authorities[0] || null, minimum: phase.approval.minimum || 1 } : { group: null, minimum: 1 }, inputs: (phase.inputs || []).slice() };
    });
    (model.agents || []).forEach(function (agent) {
      draft.agents[agent.id] = { id: agent.id, label: agent.label, description: agent.description, tools: agent.tools.slice(), views: agent.views.slice(), instructions: agent.instructions || '', scope: agent.scope, isNew: false, role: null };
    });
    (model.groups || []).forEach(function (group) {
      draft.groups[group.id] = { id: group.id, label: group.label, members: clone(group.members || []), status: group.status, isNew: false };
    });
    return draft;
  }

  function approvalChange(step) {
    return step.approval.group ? { group: step.approval.group, minimum: step.approval.minimum || 1 } : 'none';
  }

  /** A step copy starts with the values shown in its workflow, retaining unsaved catalog edits. */
  function copiedPhaseDraft(model, draft, workflowId, phaseId, id) {
    var source = draft.phases[phaseId];
    var settings = draft.steps[workflowId][phaseId] || {};
    var output = !settings.output || source.output !== source.baseOutput ? source.output : settings.output;
    var baseline = (model.phases || []).find(function (phase) { return phase.id === phaseId; });
    var workflow = draft.workflows[workflowId];
    var originalWorkflow = (model.workflows || []).find(function (entry) { return entry.id === (workflow.copyOf || workflowId) && entry.phases.indexOf(phaseId) >= 0; });
    var copyFromWorkflow = originalWorkflow ? originalWorkflow.id : workflow.installFrom && source.fromBlueprint ? workflow.installFrom : null;
    return Object.assign(clone(source), { id: id, label: source.label + ' (' + workflow.label + ')', isNew: true, copyOf: phaseId, copyFromWorkflow: copyFromWorkflow, usedBy: [workflowId], output: output, baseOutput: output,
      views: baseline && same(source.views, baseline.views) && settings.views ? settings.views.slice() : (source.views || []).slice(),
      clarification: baseline && source.clarification === baseline.clarification ? settings.clarification || 'off' : source.clarification,
      authoringSkill: settings.authoringSkill || null });
  }

  /** The engine change set that turns the model into the draft. */
  function changeSetFrom(model, draft) {
    var base = initialDraft(model);
    var changes = [];
    Object.keys(draft.groups).forEach(function (id) {
      var group = draft.groups[id]; var before = base.groups[id];
      if (!before) { changes.push({ op: 'group.create', id: id, label: group.label, members: group.members }); return; }
      var patch = { op: 'group.update', id: id };
      if (before.label !== group.label) patch.label = group.label;
      if (!same(before.members, group.members)) patch.members = group.members;
      if (Object.keys(patch).length > 2) changes.push(patch);
    });
    Object.keys(draft.agents).forEach(function (id) {
      var agent = draft.agents[id]; var before = base.agents[id];
      if (!before) { changes.push({ op: 'agent.create', id: id, label: agent.label, description: agent.description, role: agent.role || 'blank', tools: agent.tools, views: agent.views, instructions: agent.instructions }); return; }
      var patch = { op: 'agent.update', id: id };
      ['label', 'description', 'instructions'].forEach(function (key) { if (before[key] !== agent[key]) patch[key] = agent[key]; });
      ['tools', 'views'].forEach(function (key) { if (!same(before[key], agent[key])) patch[key] = agent[key]; });
      if (Object.keys(patch).length > 2) changes.push(patch);
    });
    var installs = {};
    Object.keys(draft.workflows).forEach(function (id) { var from = draft.workflows[id].installFrom; if (from && !installs[from]) { installs[from] = true; changes.push({ op: 'workflow.install', id: from }); } });
    Object.keys(draft.phases).forEach(function (id) {
      var phase = draft.phases[id];
      if (phase.isNew) {
        var home = Object.keys(draft.workflows).find(function (workflowId) { return draft.workflows[workflowId].phases.indexOf(id) >= 0; });
        var step = home && draft.steps[home][id] ? draft.steps[home][id] : { approval: phase.approval, inputs: phase.inputs };
        var create = { op: 'phase.create', id: id, label: phase.label, output: phase.output, inputs: step.inputs, approval: approvalChange(step), views: phase.views, agent: phase.agent, clarification: phase.clarification || 'off', authoringSkill: step.authoringSkill || null };
        if (phase.copyOf) create.copyOf = phase.copyOf;
        if (phase.copyFromWorkflow) create.copyFromWorkflow = phase.copyFromWorkflow;
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
        if (!phase || phase.isNew) return;
        var step = draft.steps[id] && draft.steps[id][phaseId];
        var reference = before && base.steps[id] && base.steps[id][phaseId] ? base.steps[id][phaseId]
          : copySource && base.steps[copySource] && base.steps[copySource][phaseId] ? base.steps[copySource][phaseId]
            : { approval: (base.phases[phaseId] || phase).approval, inputs: (base.phases[phaseId] || phase).inputs };
        if (!step) return;
        var update = { op: 'phase.update', id: phaseId, workflow: id };
        if (!same(reference.approval, step.approval)) update.approval = approvalChange(step);
        if (!same(reference.inputs, step.inputs)) update.inputs = step.inputs;
        // The engine writes it where the workflow owns it: an override on a shared or already
        // overridden step, the step itself otherwise.
        var referenceSkill = reference.authoringSkill === undefined ? ((base.phases[phaseId] || phase).authoringSkill || null) : reference.authoringSkill;
        if ((step.authoringSkill || null) !== (referenceSkill || null)) update.authoringSkill = step.authoringSkill || null;
        if (Object.keys(update).length > 3) changes.push(update);
      });
    });
    // Imports and marketplace trust are explicit operations the person queued; the engine orders them.
    (draft.imports || []).forEach(function (change) { changes.push(clone(change)); });
    return { schema: 'sflow-studio-change-set@1', base: model.base, changes: changes };
  }

  /** Plain words for one change, shown before the engine checks it. */
  function describe(change, draft) {
    function phaseName(id) { return (draft.phases[id] || {}).label || id; }
    function agentName(id) { return (draft.agents[id] || {}).label || id; }
    switch (change.op) {
      case 'workflow.create': return 'New workflow ' + change.label + (change.copyOf ? ', a copy of ' + ((draft.workflows[change.copyOf] || {}).label || change.copyOf) : '') + ': ' + change.phases.map(phaseName).join(' → ');
      case 'workflow.install': return 'Add the packaged ' + (((state.model && state.model.blueprints) || []).find(function (bp) { return bp.id === change.id; }) || { label: change.id }).label + ' workflow';
      case 'workflow.update': return (change.label || (draft.workflows[change.id] || {}).label || change.id) + ': ' + Object.keys(change).filter(function (key) { return ['op', 'id'].indexOf(key) < 0; }).map(function (key) { return { label: 'name', description: 'description', phases: 'steps', reworkLoops: 'send-back rules', decisions: 'decisions' }[key] || key; }).join(', ') + ' changed';
      case 'phase.create': return 'New step ' + change.label + ', drafted by ' + agentName(change.agent) + (change.authoringSkill ? ' with /' + change.authoringSkill : '');
      case 'phase.update': return phaseName(change.id) + ': ' + Object.keys(change).filter(function (key) { return ['op', 'id', 'workflow'].indexOf(key) < 0; }).map(function (key) { return { label: 'name', output: 'output', views: 'knowledge', clarification: 'questions', approval: 'sign-off', inputs: 'what it reads', authoringSkill: 'drafting skill' }[key] || key; }).join(', ') + ' changed' + (change.workflow && (change.approval !== undefined || change.inputs !== undefined || change.authoringSkill !== undefined) ? ' in ' + ((draft.workflows[change.workflow] || {}).label || change.workflow) : '');
      case 'phase.agent': return phaseName(change.phase) + ' is now drafted by ' + agentName(change.agent);
      case 'agent.create': return 'New agent ' + change.label;
      case 'agent.update': return 'Agent ' + agentName(change.id) + ' changed';
      case 'group.create': return 'New approval group ' + change.label;
      case 'group.update': return ((draft.groups[change.id] || {}).label || change.id) + ': ' + (change.members ? 'people' : 'name') + ' changed';
      case 'import.skill': return (change.replace ? 'Update skill ' : 'Skill ') + change.id + ' for ' + agentName(change.agent) + (change.phases && change.phases.length ? ' in ' + change.phases.map(phaseName).join(', ') : '') + ', from ' + change.source;
      case 'import.template': return (change.replace ? 'Update template ' : 'Template ') + (change.label || change.id) + ' from ' + change.source + (change.phases && change.phases.length ? ', used by ' + change.phases.map(phaseName).join(', ') : '');
      case 'import.agent': return (change.replace ? 'Update an agent' : 'Agent') + ' from ' + change.source + (change.withoutDefaults ? ', without taking over steps' : '');
      case 'import.generated': return agentName(change.agent) + ' fetches ' + change.target + ' for ' + phaseName(change.phase);
      case 'import.mcpServer': return (change.replace ? 'Update MCP server' : 'MCP server') + ' from ' + change.source + (change.agents && change.agents.length ? ' for ' + change.agents.map(agentName).join(', ') : ', for imports only');
      case 'import.remove': return 'Remove ' + change.key;
      case 'marketplace.add': return 'Trust marketplace ' + (change.label || change.id);
      case 'marketplace.remove': return 'Stop trusting marketplace ' + change.id;
      default: return change.op;
    }
  }

  window.__workflowStudio = { initialDraft: initialDraft, changeSetFrom: changeSetFrom, copiedPhaseDraft: copiedPhaseDraft, describe: describe, kebab: kebab,
    newDecision: function () { return newDecision.apply(null, arguments); }, convertDecision: function () { return convertDecision.apply(null, arguments); },
    decisionLines: function () { return decisionLines.apply(null, arguments); }, reachOf: function () { return reachOf.apply(null, arguments); },
    targetOptions: function () { return targetOptions.apply(null, arguments); }, pruneDecisions: function () { return pruneDecisions.apply(null, arguments); },
    relabelRules: function () { return relabelRules.apply(null, arguments); }, buildTest: function () { return buildTest.apply(null, arguments); },
    importKey: function () { return importKey.apply(null, arguments); }, linkId: function () { return linkId.apply(null, arguments); },
    canvasLayout: function () { return canvasLayout.apply(null, arguments); }, copyStep: function () { return copyStep.apply(null, arguments); },
    // The draft operations the inspector runs, against the model the host sent, and that state.
    state: function () { return state; },
    createStep: function () { return createStep.apply(null, arguments); }, addExistingStep: function () { return addExistingStep.apply(null, arguments); },
    copyStepForWorkflow: function () { return copyStepForWorkflow.apply(null, arguments); }, stepSettings: function () { return stepSettings.apply(null, arguments); },
    stepOutput: function () { return stepOutput.apply(null, arguments); }, setStepOutput: function () { return setStepOutput.apply(null, arguments); },
    skillPicker: function () { return skillPicker.apply(null, arguments); }, chooseAuthoringSkill: function () { return chooseAuthoringSkill.apply(null, arguments); },
    authoringSkillControl: function () { return authoringSkillControl.apply(null, arguments); } };

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
    return el('select', Object.assign({ id: id, 'data-key': id, onchange: function (event) { onChange(event.target.value); } }, attrs || {}),
      options.map(function (option) { return el('option', { value: option.value, selected: option.value === value, disabled: option.disabled }, option.label); }));
  }
  function field(id, label, control, hint) {
    return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
  }
  function textInput(id, value, onChange, attrs) {
    return el('input', Object.assign({ type: 'text', id: id, 'data-key': id, value: value || '', onchange: function (event) { onChange(event.target.value); } }, attrs || {}));
  }

  function post(message) { vscodeApi.postMessage(message); }
  function setStatus(text) { state.status = text; var node = document.getElementById('studio-status'); if (node) node.textContent = text; }

  // ---- Draft operations ----------------------------------------------------------------------

  function workflowSteps(workflowId) { var workflow = state.draft.workflows[workflowId]; return workflow ? workflow.phases : []; }
  function settingsIn(draft, workflowId, phaseId) {
    var steps = draft.steps[workflowId] || (draft.steps[workflowId] = {});
    if (!steps[phaseId]) {
      var phase = draft.phases[phaseId] || {};
      var order = draft.workflows[workflowId] ? draft.workflows[workflowId].phases : [];
      steps[phaseId] = { approval: clone(phase.approval || { group: null, minimum: 1 }), inputs: (phase.inputs || []).filter(function (input) { return order.indexOf(input) >= 0; }), authoringSkill: phase.authoringSkill || null };
    }
    return steps[phaseId];
  }
  function stepSettings(workflowId, phaseId) { return settingsIn(state.draft, workflowId, phaseId); }
  /** What a step produces in one workflow: that workflow's own value, unless the step itself was edited. */
  function stepOutput(workflowId, phaseId) {
    var phase = state.draft.phases[phaseId] || { output: 'document' };
    var settings = state.draft.steps[workflowId] && state.draft.steps[workflowId][phaseId];
    if (!settings || !settings.output || phase.output !== phase.baseOutput) return phase.output;
    return settings.output;
  }
  function changesNow() { return state.draft && state.model ? changeSetFrom(state.model, state.draft).changes : []; }
  function changed() { state.plan = null; state.planKey = null; if (/^Checked:/.test(state.status)) setStatus(''); requestRender(); }

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

  function createStep(workflowId, label, output, agent, afterId) {
    var id = kebab(label);
    if (!id) { setStatus('Give the new step a name.'); return null; }
    if (state.draft.phases[id]) { setStatus('A step called ' + label + ' already exists; add it from the list instead.'); return null; }
    var firstGroup = Object.keys(state.draft.groups)[0] || null;
    var phases = workflowSteps(workflowId);
    var previous = afterId && phases.indexOf(afterId) >= 0 ? [afterId] : phases.slice(-1);
    state.draft.phases[id] = { id: id, label: label, output: output, views: [], clarification: 'off', agent: agent, usedBy: [workflowId], isNew: true, fromBlueprint: null, approval: { group: firstGroup, minimum: 1 }, inputs: previous };
    insertStep(workflowId, id, afterId);
    state.draft.steps[workflowId][id] = { approval: { group: firstGroup, minimum: 1 }, inputs: previous };
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
    draft.steps[workflowId][id] = settings;
    draft.steps[workflowId][id].authoringSkillSetByWorkflow = false;
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
  function groupOptions() {
    return Object.keys(state.draft.groups).map(function (id) { var group = state.draft.groups[id]; return { value: id, label: group.label + ' · ' + groupHint(group) }; }).concat([{ value: '', label: 'No sign-off' }]);
  }

  function renderNav(root) {
    var pending = changesNow().length;
    var blocked = Object.keys(state.draft.groups).filter(groupBlocked).length;
    // On the canvas the navigation folds to icons, so the workflow gets the width.
    var compact = state.view === 'board';
    function item(view, label, iconName, count, attention) {
      var current = state.view === view || (view === 'home' && (state.view === 'board' || state.view === 'new'));
      var go = function () { state.view = view; render(); };
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
      item('library', 'Library', 'book', (state.model.imports || []).length || null, false),
      item('people', 'People & approvals', 'people', blocked || null, blocked > 0),
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
    main.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Your workflows' }), button('New workflow', function () { state.view = 'new'; state.wizard = { label: '', from: null }; render(); }, { class: 'primary' })));
    workflows.forEach(function (id) {
      var workflow = state.draft.workflows[id];
      var code = workflow.phases.some(function (phaseId) { return stepOutput(id, phaseId) === 'code'; });
      main.appendChild(el('article', { class: 'studio-card' },
        el('div', { class: 'studio-row spread' },
          el('div', { class: 'studio-row' }, el('strong', { text: workflow.label }), workflow.isNew || workflow.installFrom ? el('span', { class: 'pill new', text: 'NEW' }) : null),
          el('div', { class: 'studio-row' },
            button('Open', function () { state.workflow = id; state.step = workflow.phases[0]; state.view = 'board'; render(); }, { class: 'secondary', 'aria-label': 'Open ' + workflow.label }),
            button('Duplicate', function () { state.view = 'new'; state.wizard = { label: workflow.label + ' copy', from: 'workflow:' + id }; render(); }, { class: 'secondary', 'aria-label': 'Duplicate ' + workflow.label }))),
        el('span', { class: 'muted', text: workflow.phases.length + ' steps' + (code ? ' · writes code' : '') }),
        rail(workflow.phases)));
    });
  }

  function renderWizard(main) {
    var wizard = state.wizard;
    var choices = Object.keys(state.draft.workflows).map(function (id) { var workflow = state.draft.workflows[id]; return { key: 'workflow:' + id, label: workflow.label, description: 'Copy the steps of your ' + workflow.label + ' workflow.', phases: workflow.phases }; })
      .concat((state.model.blueprints || []).filter(function (bp) { return !bp.installed && !state.draft.workflows[bp.id]; }).map(function (bp) { return { key: 'blueprint:' + bp.id, label: bp.label, description: (bp.description || 'A packaged workflow.') + ' Adds its steps and agents.', phases: bp.phases, blueprint: bp }; }))
      .concat([{ key: 'blank', label: 'Blank', description: 'Start with one step and add what you need. Good for analysis or review work with no code.', phases: [Object.keys(state.draft.phases).indexOf('intake') >= 0 ? 'intake' : Object.keys(state.draft.phases)[0]] }]);
    if (!wizard.from) wizard.from = 'blank';
    var id = kebab(wizard.label);
    main.appendChild(el('header', null, el('h1', { text: 'New workflow' }), el('p', { class: 'studio-lede', text: 'Name it and pick the closest starting point. You can add, remove and reorder steps next.' })));
    main.appendChild(el('div', { class: 'grid-2', style: 'max-width:820px' },
      field('wizard-name', 'Workflow name', textInput('wizard-name', wizard.label, function (value) { wizard.label = value; requestRender(); }, { placeholder: 'Vendor assessment' }),
        id ? 'ID ' + id + (state.draft.workflows[id] ? ' is already used: choose another name' : '') : 'The ID is made from the name.'),
      field('wizard-description', 'What is it for? (optional)', textInput('wizard-description', wizard.description, function (value) { wizard.description = value; }))));
    main.appendChild(el('div', { class: 'blueprints', role: 'group', 'aria-label': 'Start from' }, choices.map(function (choice) {
      return el('button', { type: 'button', class: 'blueprint', 'aria-pressed': wizard.from === choice.key ? 'true' : 'false', onclick: function () { wizard.from = choice.key; if (!wizard.label && choice.blueprint) wizard.label = choice.label; render(); } },
        el('strong', { text: choice.label }), el('span', { class: 'muted', text: choice.description }),
        el('span', { class: 'rail' }, choice.phases.slice(0, 7).map(function (phaseId) { return el('span', { class: 'pill', text: ((state.draft.phases[phaseId] || (state.model.blueprintPhases || {})[phaseId] || { label: phaseId }).label) }); })));
    })));
    var blocked = !id || Boolean(state.draft.workflows[id]);
    main.appendChild(el('div', { class: 'studio-row' },
      button('Shape the steps', function () { createWorkflowFromWizard(choices.find(function (choice) { return choice.key === wizard.from; }), id); }, { class: 'primary', disabled: blocked }),
      button('Cancel', function () { state.view = 'home'; render(); })));
  }

  function createWorkflowFromWizard(choice, id) {
    var label = state.wizard.label.trim();
    var workflow = { id: id, label: label, description: (state.wizard.description || '').trim(), phases: choice.phases.slice(), reworkLoops: [], decisions: [], isNew: true, installFrom: null };
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
    if (decision.kind !== 'ask') body.appendChild(inputsEditor(decision));
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

  var NODE_W = 176, NODE_H = 124, GAP = 64, DECISION_GAP = 104, CANVAS_PAD = 40, LOOP_STEP = 26, FINISH_W = 84;
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
    flag: 'M5 21V4 M5 4h11l-2 4 2 4H5'
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
  function transformOf(view) { return 'translate(' + Math.round(view.panX) + 'px,' + Math.round(view.panY) + 'px) scale(' + view.zoom + ')'; }

  /** Where each step sits and how every arrow runs: order, send-back rules and decision routes. */
  function canvasLayout(workflow) {
    var phases = workflow.phases;
    var nodes = []; var x = CANVAS_PAD;
    phases.forEach(function (phaseId, index) {
      nodes.push({ id: phaseId, index: index, x: x });
      x += NODE_W + (decisionAfterStep(workflow, phaseId) ? DECISION_GAP : GAP);
    });
    var finishX = x;
    var edges = []; var above = 0; var below = 0;
    phases.forEach(function (phaseId, index) {
      var decision = decisionAfterStep(workflow, phaseId);
      edges.push({ kind: 'next', from: index, to: index + 1, decision: decision ? decision.id : null });
    });
    (workflow.reworkLoops || []).forEach(function (loop) {
      var from = phases.indexOf(loop.from); var to = phases.indexOf(loop.to);
      if (from < 0 || to < 0) return;
      below += 1;
      edges.push({ kind: 'send-back', from: from, to: to, depth: below, step: loop.from, label: 'If rejected, back to ' + stepLabel(loop.to),
        title: 'If ' + stepLabel(loop.from) + ' is rejected, it goes back to ' + stepLabel(loop.to) + ', at most ' + loop.maxAttempts + (loop.maxAttempts === 1 ? ' time' : ' times') });
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
          below += 1;
          edges.push({ kind: 'decision-back', from: after, to: phases.indexOf(reach.target), depth: below, decision: decision.id, label: route.label });
          return;
        }
        above += 1;
        edges.push({ kind: reach.kind === 'end' ? 'decision-end' : 'decision-skip', from: after, to: reach.kind === 'end' ? phases.length : phases.indexOf(reach.target), depth: above, decision: decision.id, label: route.label });
      });
    });
    var rowY = CANVAS_PAD + (above ? above * LOOP_STEP + 14 : 0);
    return { nodes: nodes, edges: edges, rowY: rowY, finishX: finishX, above: above, below: below,
      width: finishX + FINISH_W + CANVAS_PAD, height: rowY + NODE_H + (below ? below * LOOP_STEP + 24 : 0) + CANVAS_PAD };
  }

  /** The path of one arrow, and the point its label sits on. */
  function edgeGeometry(layout, edge) {
    function at(index) { return index >= layout.nodes.length ? layout.finishX : layout.nodes[index].x; }
    var top = layout.rowY; var bottom = layout.rowY + NODE_H; var middle = layout.rowY + NODE_H / 2;
    if (edge.kind === 'next') {
      var start = at(edge.from) + NODE_W; var end = at(edge.to);
      return { d: 'M' + start + ' ' + middle + ' H' + (end - 2), tone: 'next', x: (start + end) / 2, y: middle };
    }
    // Arrows at different depths leave and land a little apart, so stacked ones stay distinguishable.
    var shift = ((edge.depth - 1) % 4) * 8;
    if (edge.kind === 'decision-skip' || edge.kind === 'decision-end') {
      var y = top - edge.depth * LOOP_STEP;
      var toFinish = edge.to >= layout.nodes.length;
      var x1 = at(edge.from) + NODE_W * 0.7 + shift;
      var x2 = toFinish ? layout.finishX + FINISH_W / 2 - shift : at(edge.to) + NODE_W * 0.3 - shift;
      var land = toFinish ? middle - 18 : top;
      return { d: 'M' + x1 + ' ' + top + ' V' + y + ' H' + x2 + ' V' + (land - 2), tone: 'decision', x: (x1 + x2) / 2, y: y };
    }
    var low = bottom + edge.depth * LOOP_STEP;
    var self = edge.from === edge.to;
    var from = at(edge.from) + (self ? NODE_W * 0.62 + shift : NODE_W * 0.3 - shift);
    var to = at(edge.to) + (self ? NODE_W * 0.38 - shift : NODE_W * 0.7 + shift);
    return { d: 'M' + from + ' ' + bottom + ' V' + low + ' H' + to + ' V' + (bottom + 2), tone: edge.kind === 'send-back' ? 'send-back' : 'decision', x: (from + to) / 2, y: low, dashed: edge.kind === 'decision-back' };
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
      svg.appendChild(svgEl('path', { d: shape.d, class: 'edge edge-' + shape.tone + (shape.dashed ? ' dashed' : ''), 'marker-end': 'url(#head-' + shape.tone + ')' }));
    });
    return svg;
  }

  function selectStep(phaseId) { state.step = phaseId; state.decision = null; state.panel = null; render(); }
  function openDecision(decision) { if (!decision) return; state.step = decision.after; state.decision = decision.id; state.panel = null; render(); }
  function findMatches(view, phase, agent) {
    var query = String(view.find || '').trim().toLowerCase();
    return Boolean(query) && (String(phase.label).toLowerCase().indexOf(query) >= 0 || Boolean(agent && agent.label.toLowerCase().indexOf(query) >= 0));
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
    var signText = !group ? 'No sign-off' : blocked ? 'Nobody can approve it yet'
      : minimum + (minimum === 1 ? ' approval' : ' approvals') + ' from ' + group.label;
    var card = el('div', {
      class: 'node tone-' + look.tone + (selected ? ' selected' : '') + (blocked ? ' blocked' : '') + (findMatches(view, phase, agent) ? ' match' : ''),
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
        type: 'button', class: 'node-main', 'data-key': 'node-' + phaseId, 'aria-pressed': selected ? 'true' : 'false',
        'aria-label': 'Step ' + (node.index + 1) + ' of ' + phases.length + ': ' + phase.label + '. ' + look.label + ', drafted by ' + (agent ? agent.label : 'no agent yet') + '. ' + signText + '.',
        onclick: function () { selectStep(phaseId); },
        onkeydown: function (event) {
          var next = event.key === 'ArrowRight' ? node.index + 1 : event.key === 'ArrowLeft' ? node.index - 1 : -1;
          if (next < 0 || next >= phases.length) return;
          event.preventDefault(); state.focusKey = 'node-' + phases[next]; view.reveal = phases[next]; selectStep(phases[next]);
        }
      },
        el('span', { class: 'node-head' }, el('span', { class: 'node-icon' }, icon(look.icon, 16)), el('span', { class: 'node-step', text: 'STEP ' + (node.index + 1) }),
          phase.isNew || phase.fromBlueprint ? el('span', { class: 'pill new', text: 'NEW' }) : null,
          settings.authoringSkill ? el('span', { class: 'pill skill', title: 'Drafted with /' + settings.authoringSkill, text: '/' + settings.authoringSkill }) : null),
        el('span', { class: 'node-title', text: phase.label }),
        el('span', { class: 'node-foot' },
          el('span', { class: 'node-agent', title: agent ? agent.label : 'Choose an agent' }, el('span', { class: 'avatar', text: agent ? initials(agent.label) : '?' }), el('span', { class: 'name', text: agent ? agent.label : 'Choose an agent' })),
          el('span', { class: 'node-sign' + (blocked ? ' bad' : group ? '' : ' none'), title: signText }, icon(group ? 'people' : 'right', 12), group ? String(minimum) : 'auto'))),
      el('div', { class: 'node-tools' },
        el('button', { type: 'button', title: 'Move earlier', 'aria-label': 'Move ' + phase.label + ' earlier', disabled: node.index === 0, onclick: function () { moveStep(workflowId, phaseId, -1); } }, icon('left', 14)),
        el('button', { type: 'button', title: 'Move later', 'aria-label': 'Move ' + phase.label + ' later', disabled: node.index === phases.length - 1, onclick: function () { moveStep(workflowId, phaseId, 1); } }, icon('right', 14)),
        el('button', { type: 'button', title: 'Remove from this workflow', 'aria-label': 'Remove ' + phase.label + ' from this workflow', onclick: function () { removeStep(workflowId, phaseId); } }, icon('trash', 14))));
    card.style.cssText = 'left:' + node.x + 'px;top:' + layout.rowY + 'px;width:' + NODE_W + 'px;height:' + NODE_H + 'px';
    return card;
  }

  function renderToolRail(workflowId, workflow, view) {
    var selected = workflow.phases.indexOf(state.step) >= 0 ? state.step : null;
    var existing = selected ? decisionAfterStep(workflow, selected) : null;
    var signed = Boolean(selected && stepSettings(workflowId, selected).approval.group);
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
      tool('gear', 'Workflow settings: name, description and rules', function () { state.panel = 'workflow'; state.decision = null; render(); }, { 'aria-pressed': state.panel === 'workflow' ? 'true' : 'false' }));
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
    return el('div', { class: 'canvas-legend', 'aria-hidden': 'true' },
      ['document', 'analysis', 'code', 'none'].map(function (output) { var look = OUTPUT_LOOK[output]; return el('span', { class: 'legend tone-' + look.tone }, el('span', { class: 'legend-dot' }), look.label); }),
      el('span', { class: 'legend tone-purple' }, el('span', { class: 'legend-dot diamond-dot' }), 'Decision'),
      el('span', { class: 'legend tone-orange' }, el('span', { class: 'legend-line' }), 'Send back'),
      el('span', { class: 'legend hint-text', text: 'Drag the background to move · Ctrl or Cmd + wheel to zoom' }));
  }

  function renderCanvas(workflowId, workflow) {
    var view = canvasView(workflowId);
    var layout = canvasLayout(workflow);
    var viewport = el('div', { class: 'canvas', role: 'region', 'aria-label': 'Steps of ' + workflow.label + '. Drag the background to move around; Ctrl or Cmd with the mouse wheel zooms.' });
    var world = el('div', { class: 'canvas-world' });
    world.style.cssText = 'width:' + layout.width + 'px;height:' + layout.height + 'px';
    world.appendChild(renderEdges(layout));
    layout.nodes.forEach(function (node) { world.appendChild(renderNode(workflowId, workflow, node, layout, view)); });
    var finish = el('div', { class: 'finish', title: 'The Story is complete' }, icon('flag', 14), 'Finish');
    finish.style.cssText = 'left:' + layout.finishX + 'px;top:' + (layout.rowY + NODE_H / 2 - 18) + 'px;width:' + FINISH_W + 'px;height:36px';
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
      var label = el('button', { type: 'button', class: 'edge-label tone-' + shape.tone, text: edge.label, title: edge.title || edge.label, onclick: function () {
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
      var left = view.panX + node.x * view.zoom; var right = left + NODE_W * view.zoom;
      if (left < 60) view.panX += 60 - left;
      else if (right > width - 16) view.panX -= right - (width - 16);
      apply();
    }
    viewport.appendChild(el('div', { class: 'zoom-controls', role: 'toolbar', 'aria-label': 'Zoom' },
      el('button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: function () { zoomAt(1 / 1.2); } }, icon('minus', 14)),
      level,
      el('button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: function () { zoomAt(1.2); } }, icon('plus', 14)),
      el('button', { type: 'button', title: 'Fit the whole workflow', 'aria-label': 'Fit the whole workflow', onclick: function () { fit(false); } }, icon('fit', 14))));
    viewport.appendChild(legend());
    if (view.finding) viewport.appendChild(findBox(workflow, view, world));
    var pan = null;
    viewport.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || event.target.closest('.node, .diamond-node, .edge-label, .zoom-controls, .tool-rail, .find-box')) return;
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
      if (!view.fitted) { view.fitted = true; fit(true); }
      if (view.reveal) { reveal(view.reveal); view.reveal = null; }
    }, 0);
    return viewport;
  }

  /** A collapsible inspector section, with an optional switch in its header and a summary shown when closed. */
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
  function propTitle(tone, iconName, eyebrow, title) {
    return el('div', { class: 'prop-title' }, el('span', { class: 'node-icon tone-' + tone }, icon(iconName, 18)),
      el('div', null, el('div', { class: 'lane-label', text: eyebrow }), el('h2', { text: title })));
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
    var phases = workflow.phases;
    if (phases.indexOf(state.step) < 0) state.step = phases[0];
    main.appendChild(el('div', { class: 'board-head' },
      el('div', { class: 'studio-row' },
        el('button', { type: 'button', class: 'crumb', onclick: function () { state.view = 'home'; render(); } }, 'Workflows'),
        el('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '›' }),
        select('board-workflow', Object.keys(state.draft.workflows).map(function (id) { return { value: id, label: state.draft.workflows[id].label }; }), workflowId, function (value) {
          state.workflow = value; state.step = state.draft.workflows[value].phases[0]; state.decision = null; state.panel = null; render();
        }, { 'aria-label': 'Workflow' }),
        workflow.isNew || workflow.installFrom ? el('span', { class: 'pill new', text: 'New · not published' }) : null,
        el('span', { class: 'muted', text: phases.length + (phases.length === 1 ? ' step' : ' steps') + (workflow.description ? ' · ' + workflow.description : '') })),
      button('Review changes (' + changesNow().length + ')', function () { state.view = 'changes'; render(); }, { class: 'primary' })));
    var selectedDecision = state.decision ? decisionById(workflow, state.decision) : null;
    if (!selectedDecision) state.decision = null;
    var inspector = state.panel === 'add' ? renderAddStep(workflowId, workflow)
      : state.panel === 'workflow' ? renderWorkflowProperties(workflowId, workflow)
        : selectedDecision ? renderDecisionInspector(workflowId, selectedDecision) : renderInspector(workflowId, state.step);
    main.appendChild(el('div', { class: 'board' }, renderCanvas(workflowId, workflow), inspector));
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
      field('add-new-agent', 'Drafted by', select('add-new-agent', agentOptions(adding.agent), adding.agent, function (value) { if (value === '__new__') { openAgentForm({ returnTo: 'board-add' }); return; } adding.agent = value; })),
      el('div', { class: 'studio-row' }, button('Create step', function () {
        if (!adding.agent) { setStatus('Choose the agent that drafts the new step.'); return; }
        if (createStep(workflowId, adding.label.trim(), adding.output, adding.agent, adding.after)) { adding.label = ''; state.panel = null; }
      }, { class: 'primary' }))
    ]));
    aside.appendChild(el('div', { class: 'prop-actions' }, button('Cancel', function () { state.panel = null; render(); }, { class: 'secondary' })));
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
    aside.appendChild(el('div', { class: 'prop-actions' }, button('Back to the step', function () { state.panel = null; render(); }, { class: 'secondary' })));
    return aside;
  }

  /** The other workflows in the draft that use a step. */
  function otherUsers(workflowId, phaseId) {
    return Object.keys(state.draft.workflows).filter(function (id) { return id !== workflowId && state.draft.workflows[id].phases.indexOf(phaseId) >= 0; });
  }

  /**
   * Which skill drafts a step in this workflow, as Drafted with offers it: nothing for a sign-off-only
   * step, a fixed /sf-converge for deterministic convergence, otherwise Automatic, which follows what
   * the step produces, and every skill that can draft that output. On a shared step the choice is
   * this workflow's own, as sign-off is.
   */
  function skillPicker(workflowId, phaseId, settings, users) {
    var output = stepOutput(workflowId, phaseId);
    if (output === 'none') return null;
    if (phaseId === 'convergence') return { fixed: '/sf-converge', hint: 'Deterministic convergence always uses /sf-converge.' };
    var automatic = output === 'code' ? '/sf-code' : '/sf-phase';
    var choices = (state.model.choices.authoringSkills || []).filter(function (choice) { return choice.produces.indexOf(output) >= 0 && choice.label !== automatic; });
    var current = settings.authoringSkill || '';
    var options = [{ value: '', label: 'Automatic (' + automatic + ')' }].concat(choices.map(function (choice) { return { value: choice.id, label: choice.label }; }));
    if (current && !options.some(function (option) { return option.value === current; })) options.push({ value: current, label: '/' + current });
    var chosen = choices.find(function (choice) { return choice.id === current; });
    var hint = chosen && chosen.description ? chosen.description : current ? 'Drafted with /' + current + '.' : 'Chosen by what the step produces.';
    if (settings.authoringSkillSetByWorkflow) hint = 'Set by this workflow. ' + hint;
    else if (users.length) hint += ' Only this workflow changes; ' + users.map(function (id) { return state.draft.workflows[id].label; }).join(', ') + ' keep their own.';
    return { options: options, value: current, hint: hint };
  }

  /** A drafting skill picked for a step in one workflow. */
  function chooseAuthoringSkill(workflowId, phaseId, value) {
    var settings = stepSettings(workflowId, phaseId);
    settings.authoringSkill = value || null;
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

  /** After a step's output changes, a chosen skill that cannot draft it goes back to automatic. */
  function resetIncompatibleSkills(phaseId) {
    var reset = [];
    Object.keys(state.draft.workflows).forEach(function (workflowId) {
      if (state.draft.workflows[workflowId].phases.indexOf(phaseId) < 0) return;
      var settings = state.draft.steps[workflowId] && state.draft.steps[workflowId][phaseId];
      if (!settings || !settings.authoringSkill) return;
      var choice = (state.model.choices.authoringSkills || []).find(function (entry) { return entry.id === settings.authoringSkill; });
      if (choice && choice.produces.indexOf(stepOutput(workflowId, phaseId)) >= 0) return;
      reset.push('/' + settings.authoringSkill);
      settings.authoringSkill = null;
    });
    if (reset.length) setStatus('Drafted with is automatic again: ' + reset.join(', ') + ' cannot draft what this step now produces.');
  }

  /** What a step itself produces, chosen in the inspector; drafting skills follow (resetIncompatibleSkills). */
  function setStepOutput(phaseId, output) {
    state.draft.phases[phaseId].output = output;
    resetIncompatibleSkills(phaseId);
    changed();
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
    aside.appendChild(propTitle(look.tone, look.icon, 'STEP ' + (index + 1) + ' OF ' + workflow.phases.length, phase.label));

    var ownOutput = settings.overridden && settings.output && settings.output !== phase.output && phase.output === phase.baseOutput;
    aside.appendChild(section('step', 'Step', [
      field('step-name', 'Name', textInput('step-name', phase.label, function (value) { if (value.trim()) { phase.label = value.trim(); changed(); } }), users.length ? 'Renames it in ' + users.map(function (id) { return state.draft.workflows[id].label; }).join(', ') + ' too.' : null),
      field('step-output', 'Produces', select('step-output', (state.model.choices.outputs || []).map(function (output) { return { value: output.id, label: output.label }; }), stepOutput(workflowId, phaseId), function (value) { setStepOutput(phaseId, value); }, { disabled: ownOutput }),
        ownOutput ? 'This workflow sets what this step produces itself; change it in the Workflow Designer.'
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

    var group = settings.approval.group ? state.draft.groups[settings.approval.group] : null;
    var earlier = workflow.phases.slice(0, Math.max(0, index));
    var signoff = [];
    if (group) {
      var minimum = settings.approval.minimum || 1;
      var seats = Math.max(group.members.length, minimum);
      signoff.push(el('div', { class: 'grid-2' },
        field('step-group', 'Approval group', select('step-group', groupOptions().filter(function (option) { return option.value; }), settings.approval.group, function (value) { settings.approval.group = value; changed(); })),
        field('step-minimum', 'Approvals needed', select('step-minimum', [1, 2, 3, 4, 5].map(function (count) { return { value: String(count), label: String(count) }; }), String(minimum), function (value) { settings.approval.minimum = Number(value); changed(); }))));
      signoff.push(el('div', { class: 'meter', 'aria-hidden': 'true' }, Array.from({ length: Math.min(seats, 8) }, function (unused, at) { return el('span', { class: at < minimum ? 'on' : '' }); })));
      signoff.push(el('span', { class: 'hint', text: group.members.length ? minimum + ' of ' + group.members.length + ' must approve' : 'Needs ' + minimum + ' · ' + groupHint(group) }));
      if (group.members.length) {
        signoff.push(el('div', { class: 'rail' }, group.members.slice(0, 8).map(function (member) {
          var name = member.name || member.email || member.githubLogin;
          return el('span', { class: 'member' }, el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(name) }), name);
        }), group.members.length > 8 ? el('span', { class: 'muted', text: '+' + (group.members.length - 8) }) : null));
      }
      if (groupBlocked(settings.approval.group)) signoff.push(el('div', { class: 'callout bad' }, 'Nobody is in this group, so this step could never be approved.'));
      signoff.push(el('div', { class: 'studio-row' }, button('Manage people', function () { state.view = 'people'; render(); }, { class: 'secondary' })));
      var loop = workflow.reworkLoops.find(function (entry) { return entry.from === phaseId; });
      var loopCount = workflow.reworkLoops.filter(function (entry) { return entry.from === phaseId; }).length;
      signoff.push(field('step-back', 'If rejected, send back to', select('step-back', [{ value: '', label: 'This step (redo it)' }].concat(earlier.map(function (id) { return { value: id, label: stepLabel(id) }; })), loop ? loop.to : '', function (value) {
        workflow.reworkLoops = workflow.reworkLoops.filter(function (entry) { return entry.from !== phaseId; });
        if (value) {
          var kept = { from: phaseId, to: value, maxAttempts: loop ? loop.maxAttempts : 3 };
          if (loop && loop.resetOnPhase && workflow.phases.indexOf(loop.resetOnPhase) < workflow.phases.indexOf(value)) kept.resetOnPhase = loop.resetOnPhase;
          workflow.reworkLoops.push(kept);
        }
        changed();
      }, { disabled: !earlier.length || loopCount > 1 }), loopCount > 1 ? 'This step has ' + loopCount + ' send-back rules; change them in the Workflow Designer.'
        : !earlier.length ? 'The first step has no earlier step to send work back to.'
          : 'Sending work back repeats the steps in between, at most ' + (loop ? loop.maxAttempts : 3) + ' times' + (loop && loop.resetOnPhase ? ', counted again after ' + stepLabel(loop.resetOnPhase) + ' runs again' : '') + '.'));
    } else {
      signoff.push(el('span', { class: 'hint', text: 'No sign-off: when the agent submits, the Story goes straight on. Turn it on to have people approve this step.' }));
    }
    aside.appendChild(section('signoff', 'Sign-off', signoff, switchControl('step-signoff', 'People sign off this step', Boolean(group), function (on) {
      if (on) {
        var first = Object.keys(state.draft.groups)[0];
        if (!first) { setStatus('Create an approval group in People & approvals first.'); render(); return; }
        settings.approval.group = first;
      } else {
        settings.approval.group = null;
        workflow.reworkLoops = workflow.reworkLoops.filter(function (entry) { return entry.from !== phaseId; });
      }
      changed();
    }), group ? group.label + ', ' + (settings.approval.minimum || 1) : 'off'));

    aside.appendChild(section('reads', 'Reads from earlier steps', earlier.length ? el('div', { class: 'checks' }, earlier.map(function (input) {
      return el('label', null, el('input', { type: 'checkbox', 'data-key': 'reads-' + input, checked: settings.inputs.indexOf(input) >= 0, onchange: function (event) {
        settings.inputs = event.target.checked ? settings.inputs.concat([input]) : settings.inputs.filter(function (id) { return id !== input; });
        settings.inputs.sort(function (a, b) { return workflow.phases.indexOf(a) - workflow.phases.indexOf(b); }); changed();
      } }), stepLabel(input));
    })) : el('span', { class: 'hint', text: 'This is the first step; it reads the Story itself.' }), null, earlier.length ? settings.inputs.length + ' of ' + earlier.length : 'the Story', true));

    var views = state.model.choices.views || [];
    if (views.length) {
      aside.appendChild(section('views', 'Knowledge views', el('div', { class: 'checks' }, views.map(function (view) {
        return el('label', null, el('input', { type: 'checkbox', 'data-key': 'view-' + view, checked: phase.views.indexOf(view) >= 0, onchange: function (event) {
          phase.views = event.target.checked ? phase.views.concat([view]) : phase.views.filter(function (entry) { return entry !== view; }); changed();
        } }), view);
      })), null, phase.views.length ? phase.views.length + ' chosen' : 'none', true));
    }

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

    aside.appendChild(el('div', { class: 'prop-actions' },
      button('Move earlier', function () { moveStep(workflowId, phaseId, -1); }, { class: 'secondary', disabled: index === 0 }),
      button('Move later', function () { moveStep(workflowId, phaseId, 1); }, { class: 'secondary', disabled: index === workflow.phases.length - 1 }),
      button('Remove from workflow', function () { removeStep(workflowId, phaseId); }, { class: 'secondary' })));
    return aside;
  }

  function openAgentForm(context) {
    var role = (state.model.choices.roles || [])[0];
    state.agentForm = { mode: 'create', role: role ? role.id : 'blank', label: '', description: '', tools: role ? role.tools.slice() : ['read', 'search', 'edit'], views: role ? role.views.slice() : [], instructions: role ? role.instructions : '', defaults: context && context.phase ? [context.phase] : [], context: context || null };
    state.view = 'agents';
    render();
  }

  function editAgent(id, context) {
    var agent = state.draft.agents[id];
    state.agentForm = { mode: 'edit', id: id, role: null, label: agent.label, description: agent.description, tools: agent.tools.slice(), views: agent.views.slice(), instructions: agent.instructions, defaults: [], context: context || null };
    state.view = 'agents';
    render();
  }

  function renderAgents(main) {
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
        agentResources(id).length ? el('span', { style: 'font-size:12px', text: 'Skills and sources: ' + agentResources(id).map(function (resource) { return resource.id; }).join(', ') }) : null,
        button('Add a skill', function () { var lib = library(); lib.as = 'skill'; lib.pendingAgent = id; lib.preview = null; lib.target = null; state.view = 'library'; render(); }, { class: 'secondary', 'aria-label': 'Add a skill to ' + agent.label }),
        button('Edit', function () { editAgent(id, null); }, { class: 'secondary', 'aria-label': 'Edit ' + agent.label })));
    });
    main.appendChild(grid);
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
      button('Cancel', function () { var context = form.context; state.agentForm = null; if (context) { state.view = 'board'; } render(); })));
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
    { value: 'skill', label: 'A skill for one of your agents' },
    { value: 'template', label: 'A document template for steps' },
    { value: 'agent', label: 'A whole agent' },
    { value: 'mcp-server', label: 'An MCP server for your agents' }
  ];
  var KIND_WORDS = { skill: 'Skill', template: 'Template', agent: 'Agent', generated: 'Generated artifact', workflow: 'Workflow', 'mcp-server': 'MCP server' };

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
    post({ type: 'studio.importPreview', reference: reference, as: as });
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
    if (preview.as === 'skill') {
      var agents = Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); });
      var phaseIds = target.agent ? (agentSteps(target.agent).length ? agentSteps(target.agent) : Object.keys(state.draft.phases)) : [];
      card.appendChild(el('div', { class: 'grid-2' },
        field('import-agent', 'Which agent uses it', select('import-agent', [{ value: '', label: 'Choose an agent' }].concat(agents.map(function (id) { return { value: id, label: state.draft.agents[id].label }; })), target.agent, function (value) { target.agent = value; target.phases = target.phases.filter(function (phaseId) { return agentSteps(value).indexOf(phaseId) >= 0; }); render(); })),
        field('import-id', 'Skill ID', textInput('import-id', target.id, function (value) { target.id = kebab(value); requestRender(); }), 'Shown in the agent\'s skills table.')));
      if (target.agent) card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'In which of its steps (none chosen: every step it drafts)' }),
        stepChecks('import-step-', target.phases, phaseIds, function (phases) { target.phases = phases; })));
      card.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'import-optional', checked: target.optional, onchange: function (event) { target.optional = event.target.checked; } }), 'Optional: the agent works without it'));
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
      button('Cancel', function () { lib.preview = null; lib.target = null; render(); }, { class: 'secondary' })));
    return card;
  }

  function addPreviewedImport() {
    var lib = library(); var preview = lib.preview; var target = lib.target;
    var replace = Boolean(lib.replace);
    if (preview.as === 'skill') {
      if (!target.agent) { setStatus('Choose the agent that uses this skill.'); return; }
      if (!target.id) { setStatus('Give the skill an ID.'); return; }
      queueImport({ op: 'import.skill', agent: target.agent, id: target.id, source: preview.reference, sha256: preview.sha256, phases: target.phases.slice(), optional: target.optional, replace: replace },
        'Skill ' + target.id + ' for ' + state.draft.agents[target.agent].label + ' added to your changes.');
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
      textInput('market-search', lib.search || '', function (value) { lib.search = value; render(); }, { placeholder: 'Search entries', 'aria-label': 'Search entries' })));
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
    previewImport(match[1], row.kind, { agent: target.agent || '', id: target.id || '', phases: (target.phases || []).slice(), optional: false, label: '', withoutDefaults: false });
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
    box.appendChild(el('strong', { text: offer.server.label + (offer.serverInfo && offer.serverInfo.name ? ' (' + offer.serverInfo.name + (offer.serverInfo.version ? ' ' + offer.serverInfo.version : '') + ')' : '') }));
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

  function renderLibrary(main) {
    var lib = library();
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
    main.appendChild(el('header', null, el('h1', { text: 'People & approvals' }), el('p', { class: 'studio-lede', text: 'An approval group is the list of people who may sign off a step. A step can only be approved by someone in its group.' })));
    var grid = el('div', { class: 'groups-grid' });
    Object.keys(state.draft.groups).forEach(function (id) {
      var group = state.draft.groups[id];
      var approves = Object.keys(state.draft.workflows).reduce(function (list, workflowId) { workflowSteps(workflowId).forEach(function (phaseId) { var settings = state.draft.steps[workflowId][phaseId]; if (settings && settings.approval.group === id && list.indexOf(phaseId) < 0) list.push(phaseId); }); return list; }, []);
      var draftPerson = group.adding || (group.adding = { name: '', email: '' });
      grid.appendChild(el('article', { class: 'studio-card', 'aria-label': group.label },
        el('div', { class: 'studio-row spread' }, el('strong', { text: group.label }), el('span', { class: 'muted', text: groupHint(group) })),
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
    if (!changeSet.changes.length) { main.appendChild(el('p', { class: 'muted', text: 'Edit a workflow, an agent or an approval group and your changes collect here.' })); return; }
    main.appendChild(el('ol', { class: 'change-list' }, changeSet.changes.map(function (change) { return el('li', { text: describe(change, state.draft) }); })));
    var fresh = state.plan && state.planKey === key;
    main.appendChild(el('div', { class: 'studio-row' },
      button(state.busy === 'check' ? 'Checking…' : 'Check changes', function () { state.busy = 'check'; render(); post({ type: 'studio.preview', changeSet: key }); }, { class: fresh && state.plan.valid ? 'secondary' : 'primary', disabled: Boolean(state.busy) }),
      button(state.busy === 'publish' ? 'Publishing…' : publishLabel(), function () { state.busy = 'publish'; render(); post({ type: 'studio.publish', changeSet: key, count: changeSet.changes.length }); }, { class: fresh && state.plan.valid ? 'primary' : 'secondary', disabled: !fresh || !state.plan.valid || Boolean(state.busy) }),
      button('Discard all changes', function () { state.draft = initialDraft(state.model); state.plan = null; state.planKey = null; state.view = 'home'; render(); }, { class: 'secondary', disabled: Boolean(state.busy) })));
    if (state.plan && !fresh) main.appendChild(el('p', { class: 'muted', text: 'You changed something since the last check. Check again before publishing.' }));
    if (fresh) main.appendChild(renderPlan(state.plan));
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
    if (state.view === 'board') renderBoard(main);
    else if (state.view === 'new') renderWizard(main);
    else if (state.view === 'agents') renderAgents(main);
    else if (state.view === 'library') renderLibrary(main);
    else if (state.view === 'people') renderPeople(main);
    else if (state.view === 'changes') renderChanges(main);
    else renderHome(main);
    main.appendChild(el('div', { id: 'studio-status', class: 'studio-status', role: 'status', 'aria-live': 'polite', text: state.status }));
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
      if (!keep) state.draft = initialDraft(message.model);
      if (state.workflow && !state.draft.workflows[state.workflow]) state.workflow = null;
      state.busy = null; render();
    } else if (message.type === 'studio.plan') {
      state.plan = message.plan; state.planKey = message.changeSet; state.busy = null;
      setStatus(message.plan.valid ? 'Checked: ready to publish.' : 'Checked: some changes need fixing.');
      render();
    } else if (message.type === 'studio.published') {
      state.busy = null; state.plan = null; state.planKey = null; state.view = 'home';
      setStatus(message.summary || 'Published.');
    } else if (message.type === 'studio.failed') {
      state.busy = null; setStatus(message.message || 'That did not work.'); if (!state.model) state.error = message.message; render();
    } else if (message.type === 'studio.cancelled') {
      state.busy = null; render();
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
    } else if (message.type === 'studio.mcpHostAdded') {
      setStatus(message.summary || 'Host entry added.');
    } else if (message.type === 'studio.importFailed') {
      var failed = library(); failed.busy = null; failed.error = message.message || 'That did not work.'; failed.preview = null; render();
      var alert = document.querySelector('[role=alert]'); if (alert && alert.scrollIntoView) alert.scrollIntoView({ block: 'center' });
    }
  });

  if (document.getElementById('studio-root')) {
    window.addEventListener('resize', function () { if (state.view === 'board') fitBoard(); });
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
