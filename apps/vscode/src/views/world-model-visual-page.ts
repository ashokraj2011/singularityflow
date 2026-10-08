/** Interactive, offline SVG explorer. No graph service, model call or new authority surface. */
import { escape, icon } from './webview.ts';
import type { ConfigurationCenterView } from './configuration-center-model.ts';
import { layoutVisualGraph, selectVisualGraph, worldModelVisualGraphs } from './world-model-visual-model.ts';

export function worldModelVisualization(view: ConfigurationCenterView): string {
  const state = view.worldModelStatus;
  const freshness = state.readiness?.historical ? 'Historical snapshot'
    : state.rebuildReason || state.source?.status === 'stale' ? 'Needs refresh'
      : state.source?.fresh === true || state.source?.status === 'fresh' ? 'Source fresh'
        : state.built ? 'Freshness unknown' : 'Not built';
  const commit = state.authority?.commit;
  return `<section class="wm-visual" aria-label="World Model and CALM visual explorer" data-wm-graphs="${escape(JSON.stringify(worldModelVisualGraphs(view)))}">
    <div class="section-heading"><div><p class="eyebrow">Read-only visual explorer</p><h2>${icon('worldModel')}World Model &amp; CALM</h2><p class="muted">Explore repository knowledge, its workflow use and the architecture it describes.</p></div><div class="button-row"><span class="wm-state ${freshness === 'Source fresh' ? 'ready' : 'missing'}">${escape(freshness)}</span><button type="button" class="secondary" id="wm-visual-expand" aria-pressed="false">Expand map</button></div></div>
    <p class="wm-visual-binding">${escape(state.format ?? 'Format unknown')} · ${escape(state.authority?.ref ?? state.readiness?.source ?? 'Authority unknown')}${commit ? ` · commit <code title="${escape(commit)}">${escape(commit.slice(0, 12))}</code>` : ''} · ${escape(state.generatedAt ?? 'Build time unknown')}</p>
    ${state.rebuildReason ? `<p class="notice warning">${escape(state.rebuildReason)}</p>` : ''}
    <div class="wm-visual-tabs" role="tablist" aria-label="Map type"><button type="button" role="tab" id="wm-map-knowledge" aria-selected="true" aria-controls="wm-visual-panel" data-wm-map="knowledge">World Model</button><button type="button" role="tab" id="wm-map-calm" aria-selected="false" aria-controls="wm-visual-panel" tabindex="-1" data-wm-map="calm">CALM architecture</button></div>
    <div id="wm-visual-panel" role="tabpanel" aria-labelledby="wm-map-knowledge">
      <p id="wm-visual-description" class="muted"></p>
      <div class="wm-visual-toolbar"><label class="wm-visual-search">Search components, views or phases<input id="wm-visual-search" type="search" placeholder="Search this map…" autocomplete="off"></label><label>Group<select id="wm-visual-group"></select></label><label>Evidence / mode<select id="wm-visual-status"></select></label><label id="wm-visual-workflow-label">Workflow<select id="wm-visual-workflow"></select></label></div>
      <div class="wm-visual-layout"><div class="wm-visual-map">
        <div class="wm-visual-mapbar"><span id="wm-visual-count" role="status" aria-live="polite"></span><div class="button-row"><button type="button" class="secondary" data-wm-zoom="out" aria-label="Zoom out">−</button><button type="button" class="secondary" data-wm-zoom="fit">Fit</button><button type="button" class="secondary" data-wm-zoom="in" aria-label="Zoom in">+</button><button type="button" class="secondary" id="wm-visual-focus" aria-pressed="false">Focus selected</button><button type="button" class="secondary" id="wm-visual-reset">Reset</button></div></div>
        <div class="wm-visual-canvas" id="wm-visual-canvas"><svg id="wm-visual-svg" role="group" aria-label="Interactive repository map" tabindex="0" viewBox="0 0 800 400"></svg><p id="wm-visual-empty" class="empty" hidden></p></div>
        <p class="wm-visual-hint">Select a node or connection to inspect it. Drag blank space to pan; use zoom buttons or + / −. Arrow keys pan the focused canvas. Tab and Enter select items.</p>
      </div><aside class="wm-visual-inspector" aria-label="Selected map item"><p class="eyebrow">Inspector</p><h3 id="wm-visual-item-title">Select an item</h3><div id="wm-visual-item-details"><p class="muted">Inspect exact identities, fact states, routing and provenance without changing the repository.</p></div></aside></div>
      <div id="wm-visual-notices" class="wm-visual-notices"></div>
      <details class="wm-visual-list"><summary>Accessible item list</summary><div id="wm-visual-list"></div></details>
    </div>
    <p class="muted">The snapshot is reused; exploring spends no model tokens. Counts describe recorded facts, not acceptance-criteria coverage. Tables and exact records below retain controls, ordered flows and evidence gaps.</p>
  </section>`;
}

export const WORLD_MODEL_VISUAL_STYLES = `
  .wm-visual { margin-bottom: 1.5rem; font-family: var(--sf-font-sans); }
  .wm-visual [hidden] { display: none !important; }
  .wm-visual.wm-visual-expanded { position: fixed; inset: 0; z-index: 100; padding: 1.25rem; margin: 0; overflow: auto; box-sizing: border-box; background: var(--sf-bg); }
  .wm-visual-expanded .wm-visual-canvas { height: max(340px, calc(100vh - 350px)); }
  .wm-visual-expanded .wm-visual-inspector { max-height: max(450px, calc(100vh - 250px)); }
  .wm-visual .section-heading { align-items: flex-start; }
  .wm-visual .section-heading h2 { font-size: 1.25rem; margin: .1rem 0 .4rem; }
  .wm-visual-binding, .wm-visual-hint { font-size: .82rem; color: var(--sf-dim); overflow-wrap: anywhere; }
  .wm-visual-tabs { display: flex; gap: .25rem; border-bottom: var(--sf-border); margin: 1rem 0; }
  .wm-visual-tabs button { background: transparent; border: none; border-radius: 0; border-bottom: 2px solid transparent; color: var(--sf-dim); padding: .7rem .9rem; }
  .wm-visual-tabs button[aria-selected="true"] { color: var(--sf-text); border-bottom-color: var(--sf-accent); }
  .wm-visual-toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: .7rem; margin-bottom: .8rem; }
  .wm-visual-toolbar label { font-size: .78rem; color: var(--sf-dim); display: grid; gap: .35rem; min-width: 130px; }
  .wm-visual-toolbar input, .wm-visual-toolbar select { margin: 0; width: 100%; box-sizing: border-box; min-height: 34px; }
  .wm-visual-search { flex: 1; }
  .wm-visual-layout { display: grid; grid-template-columns: minmax(0, 1fr) 265px; border: var(--sf-border); border-radius: 8px; overflow: hidden; }
  .wm-visual-map { min-width: 0; background: var(--sf-bg); }
  .wm-visual-mapbar { display: flex; gap: .5rem; flex-wrap: wrap; justify-content: space-between; align-items: center; padding: .6rem .75rem; border-bottom: var(--sf-border); font-size: .78rem; color: var(--sf-dim); }
  .wm-visual-mapbar .button-row { gap: .3rem; margin: 0; }
  .wm-visual-mapbar button { padding: .3rem .55rem; min-height: 30px; font-size: .78rem; }
  .wm-visual-canvas { height: clamp(360px, 55vh, 620px); position: relative; overflow: hidden; }
  .wm-visual-canvas svg { width: 100%; height: 100%; display: block; touch-action: none; }
  .wm-visual-canvas svg:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  .wm-visual-canvas > .empty { position: absolute; inset: 25% 10% auto; text-align: center; pointer-events: none; }
  .wm-visual-map .wm-visual-hint { padding: .2rem .75rem; }
  .wm-visual-inspector { padding: 1rem; background: var(--sf-surface); border-left: var(--sf-border); min-width: 0; max-height: 720px; overflow: auto; }
  .wm-visual-inspector h3 { margin-top: .35rem; overflow-wrap: anywhere; }
  .wm-visual-inspector dl { margin: 0; }
  .wm-visual-inspector dt { font-size: .75rem; color: var(--sf-dim); margin-top: .85rem; }
  .wm-visual-inspector dd { margin: .25rem 0; font-size: .84rem; overflow-wrap: anywhere; white-space: pre-wrap; }
  .wm-visual-inspector .button-row { margin-top: 1rem; flex-wrap: wrap; gap: .5rem; }
  .wm-visual-inspector button { font-size: .8rem; }
  .wm-visual-node { cursor: pointer; outline: none; }
  .wm-visual-node rect { fill: var(--sf-surface); stroke: var(--sf-border-strong); stroke-width: 1; }
  .wm-visual-node text { fill: var(--sf-text); font-family: var(--sf-font-sans); font-size: 15px; font-weight: 400; pointer-events: none; }
  .wm-visual-node .sub { fill: var(--sf-dim); font-size: 10px; }
  .wm-visual-node .state-dot { fill: var(--sf-accent); }
  .wm-visual-node[data-uncertain="true"] .state-dot { fill: var(--sf-wait); }
  .wm-visual-node:hover rect, .wm-visual-node:focus-visible rect, .wm-visual-node[aria-pressed="true"] rect { stroke: var(--sf-accent); stroke-width: 2; }
  .wm-visual-edge { cursor: pointer; outline: none; }
  .wm-visual-edge .line { fill: none; stroke: var(--sf-dim); stroke-width: 1.2; opacity: .45; }
  .wm-visual-edge .hit { fill: none; stroke: transparent; stroke-width: 14; }
  .wm-visual-edge text { font-size: 11px; fill: var(--sf-dim); font-family: var(--sf-font-sans); paint-order: stroke; stroke: var(--sf-bg); stroke-width: 4px; stroke-linejoin: round; opacity: 0; }
  .wm-visual-edge:hover text, .wm-visual-edge:focus-visible text, .wm-visual-edge[aria-pressed="true"] text { opacity: 1; }
  .wm-visual-edge:hover .line, .wm-visual-edge:focus-visible .line, .wm-visual-edge[aria-pressed="true"] .line, .wm-visual-edge[data-connected="true"] .line { stroke: var(--sf-accent); opacity: 1; stroke-width: 2; }
  .wm-visual-arrow { fill: var(--sf-dim); }
  .wm-visual-column { fill: var(--sf-dim); font-size: 11px; font-family: var(--sf-font-sans); }
  .wm-visual-notices p { border-left: 2px solid var(--sf-border-strong); padding: .4rem .75rem; color: var(--sf-dim); font-size: .82rem; }
  .wm-visual-list { border-top: var(--sf-border); padding-top: .8rem; margin-top: .8rem; }
  .wm-visual-list button { display: block; text-align: left; margin-top: .35rem; background: transparent; color: var(--sf-text); border: var(--sf-border); }
  .wm-data-details { margin: 1.4rem 0; border: var(--sf-border); border-radius: var(--sf-radius); padding: .8rem; }
  .wm-data-details > summary { cursor: pointer; color: var(--sf-dim); }
  @media (max-width: 1080px) { .wm-visual-layout { grid-template-columns: 1fr; } .wm-visual-inspector { border-left: 0; border-top: var(--sf-border); max-height: 300px; } }
  @media (max-width: 900px) { .configuration-sidebar { position: static; } }
  @media (prefers-reduced-motion: reduce) { .wm-visual * { transition: none !important; } }
`;

// Standalone pure functions are shared with Node tests; no UI can re-resolve governed policy.
export const WORLD_MODEL_VISUAL_SCRIPT = `
(() => {
  const root = document.querySelector('[data-wm-graphs]'); if (!root) return;
  const graphs = JSON.parse(root.dataset.wmGraphs);
  const selectGraph = ${selectVisualGraph.toString()};
  const layoutGraph = ${layoutVisualGraph.toString()};
  const el = (id) => document.getElementById('wm-visual-' + id);
  const svg = el('svg'), canvas = el('canvas');
  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attributes, text) => { const node = document.createElementNS(ns, tag); for (const [name,value] of Object.entries(attributes || {})) node.setAttribute(name, String(value)); if (text !== undefined) node.textContent = text; return node; };
  const short = (text, max = 28) => text.length > max ? text.slice(0,max - 1) + '…' : text;
  let graph = graphs[0], selected = null, focus = false, box = [0,0,800,400], drag = null;
  const setBox = () => svg.setAttribute('viewBox', box.join(' '));
  const fit = (layout) => { const ratio = Math.max(.1, canvas.clientWidth / Math.max(1, canvas.clientHeight)); let width = layout.width, height = layout.height; if (width / height < ratio) width = height * ratio; else height = width / ratio; box = [-(width - layout.width)/2, -(height - layout.height)/2, width, height]; setBox(); };
  const zoom = (scale) => { const width = Math.max(160, Math.min(12000, box[2] * scale)); const height = box[3] * width / box[2]; box = [box[0] + (box[2] - width)/2, box[1] + (box[3] - height)/2, width, height]; setBox(); };
  const filters = () => ({query: el('search').value, group: el('group').value, status: el('status').value, workflow: el('workflow').value, selected, neighbors: focus});
  const options = (target, entries, label) => { target.replaceChildren(); for (const [value,text] of [['',label], ...entries]) { const option = document.createElement('option'); option.value = value; option.textContent = text; target.append(option); } };
  const inspect = () => {
    const record = [...graph.nodes,...graph.edges].find((item) => item.key === selected);
    el('focus').disabled = !graph.nodes.some((item) => item.key === selected);
    el('item-title').textContent = record?.label || 'Select an item';
    const details = el('item-details'); details.replaceChildren();
    if (!record) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Inspect exact identities, fact states, routing and provenance. The graph is read-only.'; details.append(p); return; }
    const dl = document.createElement('dl');
    for (const [label,value] of [['Kind',record.kind], ['State',record.status], ...record.details]) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; dl.append(dt,dd); }
    details.append(dl);
    const refs = document.createElement('div'); refs.className = 'button-row';
    for (const reference of record.references) { const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = reference.label; button.dataset.openWorldModelRef = reference.ref; refs.append(button); }
    details.append(refs);
    const linked = graph.edges.filter((edge) => edge.from === selected || edge.to === selected);
    if (linked.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = linked.length + ' recorded connections. Select a connection to inspect its provenance.'; details.append(p); }
  };
  const choose = (key) => {
    if (![...graph.nodes,...graph.edges].some((item) => item.key === key)) return;
    const wasFocused = focus; selected = key;
    // Inspecting a connection exits node-neighborhood mode; edge IDs are not node IDs.
    if (!graph.nodes.some((item) => item.key === key)) focus = false;
    el('focus').setAttribute('aria-pressed',String(focus)); inspect();
    if (wasFocused || focus) draw(true);
    else {
      svg.querySelectorAll('[data-wm-key]').forEach((node) => node.setAttribute('aria-pressed',String(node.dataset.wmKey === selected)));
      svg.querySelectorAll('[data-edge-from]').forEach((node) => node.dataset.connected = String(node.dataset.edgeFrom === selected || node.dataset.edgeTo === selected));
    }
  };
  const draw = (refit) => {
    const visible = selectGraph(graph, filters()), layout = layoutGraph(visible.nodes);
    svg.replaceChildren();
    const defs = make('defs'); const marker = make('marker', {id:'wm-visual-arrow',viewBox:'0 0 8 8',refX:7,refY:4,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'}); marker.append(make('path',{d:'M0 0 L8 4 L0 8 z',class:'wm-visual-arrow'})); defs.append(marker); svg.append(defs);
    const groups = new Map(); for (const node of layout.nodes) if (!groups.has(node.column)) groups.set(node.column, node);
    for (const node of groups.values()) svg.append(make('text',{x:node.x,y:28,class:'wm-visual-column'},graph.id === 'knowledge' && node.kind === 'phase' ? 'WORKFLOW PHASES' : node.group.toUpperCase()));
    const positions = new Map(layout.nodes.map((node) => [node.key,node]));
    const lanes = new Map();
    for (const edge of visible.edges) {
      const from = positions.get(edge.from), to = positions.get(edge.to);
      const routeKey = [edge.from,edge.to].sort().join('|'), lane = lanes.get(routeKey) || 0; lanes.set(routeKey,lane + 1);
      let path, labelX, labelY;
      if (from.column !== to.column) { const forward = from.x < to.x, x1 = from.x + (forward ? 230 : 0), x2 = to.x + (forward ? 0 : 230), y1 = from.y + 33, y2 = to.y + 33, mid = (x1+x2)/2 + lane*15; path = 'M'+x1+' '+y1+' C'+mid+' '+y1+','+mid+' '+y2+','+x2+' '+y2; labelX = mid; labelY = (y1+y2)/2 - 6; }
      else { const x = from.x + 230, y1 = from.y + 33, y2 = to.y + 33, bend = x + 36 + lane*16; path = 'M'+x+' '+y1+' C'+bend+' '+(y1-35)+','+bend+' '+(y2+35)+','+x+' '+y2; labelX = bend; labelY = (y1+y2)/2; }
      const g = make('g',{class:'wm-visual-edge',role:'button',tabindex:0,'aria-label':edge.label+' from '+from.label+' to '+to.label,'aria-pressed':String(selected === edge.key),'data-wm-key':edge.key,'data-edge-from':edge.from,'data-edge-to':edge.to,'data-connected':String(edge.from === selected || edge.to === selected)});
      g.append(make('title',{},edge.label+' · '+edge.status),make('path',{d:path,class:'hit'}),make('path',{d:path,class:'line','marker-end':'url(#wm-visual-arrow)'}),make('text',{x:labelX,y:labelY,'text-anchor':'middle'},short(edge.label,22))); svg.append(g);
    }
    for (const node of layout.nodes) {
      const uncertain = !['available','confirmed','required','optional'].includes(node.status);
      const g = make('g',{class:'wm-visual-node',role:'button',tabindex:0,'aria-label':node.label+' · '+node.kind+' · '+node.status,'aria-pressed':String(selected === node.key),'data-wm-key':node.key,'data-uncertain':String(uncertain)});
      g.append(make('title',{},node.label+' · '+node.group+' · '+node.status),make('rect',{x:node.x,y:node.y,width:230,height:66,rx:8}),make('circle',{cx:node.x+15,cy:node.y+22,r:3,class:'state-dot'}),make('text',{x:node.x+26,y:node.y+26},short(node.label)),make('text',{x:node.x+14,y:node.y+48,class:'sub'},short(node.kind+' · '+node.status+' · '+node.group,37))); svg.append(g);
    }
    el('count').textContent = visible.nodes.length + '/' + graph.nodes.length + ' items · ' + visible.edges.length + ' connections';
    el('empty').hidden = visible.nodes.length > 0; el('empty').textContent = graph.nodes.length ? 'No items match these filters. Reset to see the map.' : graph.empty;
    const list = el('list'); list.replaceChildren(); for (const item of [...visible.nodes,...visible.edges]) { const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.dataset.wmKey = item.key; button.textContent = item.label + ' · ' + item.kind + ' · ' + item.status; list.append(button); }
    if (refit) fit(layout);
  };
  const reset = () => { selected = null; focus = false; el('focus').setAttribute('aria-pressed','false'); el('search').value = ''; el('group').value = ''; el('status').value = ''; el('workflow').value = ''; inspect(); draw(true); };
  const switchMap = (id) => { graph = graphs.find((item) => item.id === id) || graphs[0]; root.querySelectorAll('[data-wm-map]').forEach((tab) => { const active = tab.dataset.wmMap === graph.id; tab.setAttribute('aria-selected',String(active)); tab.tabIndex = active ? 0 : -1; }); el('panel').setAttribute('aria-labelledby','wm-map-'+graph.id); el('description').textContent = graph.description; options(el('group'),[...new Set(graph.nodes.map((node) => node.group))].map((group) => [group,group]),'All groups'); options(el('status'),[...new Set(graph.nodes.map((node) => node.status))].map((status) => [status,status]),'All states'); options(el('workflow'),graph.workflows.map((workflow) => [workflow.id,workflow.label]),'All workflows'); el('workflow-label').hidden = graph.id !== 'knowledge'; const notices = el('notices'); notices.replaceChildren(); for (const notice of graph.notices) { const p = document.createElement('p'); p.textContent = notice; notices.append(p); } reset(); };
  root.addEventListener('click',(event) => {
    const tab = event.target.closest('[data-wm-map]'); if (tab) return switchMap(tab.dataset.wmMap);
    const zoomButton = event.target.closest('[data-wm-zoom]'); if (zoomButton) return zoomButton.dataset.wmZoom === 'fit' ? draw(true) : zoom(zoomButton.dataset.wmZoom === 'in' ? .8 : 1.25);
    const item = event.target.closest('[data-wm-key]'); if (item) choose(item.dataset.wmKey);
  });
  root.addEventListener('keydown',(event) => {
    if (event.key === 'Escape' && root.classList.contains('wm-visual-expanded')) { el('expand').click(); return; }
    const tab = event.target.closest('[data-wm-map]'); if (tab && ['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) { event.preventDefault(); switchMap(event.key === 'Home' ? 'knowledge' : event.key === 'End' ? 'calm' : graph.id === 'knowledge' ? 'calm' : 'knowledge'); root.querySelector('[data-wm-map="'+graph.id+'"]').focus(); return; }
    const item = event.target.closest('[data-wm-key]'); if (item && ['Enter',' '].includes(event.key)) { event.preventDefault(); choose(item.dataset.wmKey); return; }
    if (event.target !== svg) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(.8); } else if (event.key === '-') { event.preventDefault(); zoom(1.25); } else if (event.key === '0') { event.preventDefault(); draw(true); } else if (event.key.startsWith('Arrow')) { event.preventDefault(); const step = box[2] * .08; if (event.key === 'ArrowLeft') box[0] -= step; if (event.key === 'ArrowRight') box[0] += step; if (event.key === 'ArrowUp') box[1] -= step; if (event.key === 'ArrowDown') box[1] += step; setBox(); }
  });
  el('search').addEventListener('input',() => draw(true)); for (const id of ['group','status','workflow']) el(id).addEventListener('change',() => draw(true));
  el('focus').addEventListener('click',() => { if (!selected || !graph.nodes.some((node) => node.key === selected)) return; focus = !focus; el('focus').setAttribute('aria-pressed',String(focus)); draw(true); });
  el('reset').addEventListener('click',reset);
  const inertSiblings = new Map();
  el('expand').addEventListener('click',() => {
    const expanded = root.classList.toggle('wm-visual-expanded');
    el('expand').textContent = expanded ? 'Return to settings' : 'Expand map';
    el('expand').setAttribute('aria-pressed',String(expanded));
    if (expanded) {
      root.setAttribute('role','dialog'); root.setAttribute('aria-modal','true');
      // Keep keyboard focus in the expanded map without disabling any of its ancestors.
      for (let at = root; at.parentElement && at !== document.body; at = at.parentElement) {
        for (const sibling of at.parentElement.children) if (sibling !== at) { inertSiblings.set(sibling,sibling.inert); sibling.inert = true; }
      }
    } else {
      root.removeAttribute('role'); root.removeAttribute('aria-modal');
      for (const [sibling,inert] of inertSiblings) sibling.inert = inert;
      inertSiblings.clear(); el('expand').focus();
    }
    requestAnimationFrame(() => draw(true));
  });
  // Refitting only on size changes preserves zoom during inspection and avoids worker calls.
  let previousSize = ''; const observer = new ResizeObserver(() => { const size = canvas.clientWidth + ':' + canvas.clientHeight; if (size !== previousSize) { previousSize = size; draw(true); } }); observer.observe(canvas);
  svg.addEventListener('pointerdown',(event) => { if (event.button !== 0 || event.target.closest('[data-wm-key]')) return; drag = {x:event.clientX,y:event.clientY,box:[...box]}; svg.setPointerCapture(event.pointerId); });
  svg.addEventListener('pointermove',(event) => { if (!drag) return; const rect = svg.getBoundingClientRect(); const scale = Math.max(box[2]/rect.width,box[3]/rect.height); box = [drag.box[0] - (event.clientX-drag.x)*scale,drag.box[1] - (event.clientY-drag.y)*scale,drag.box[2],drag.box[3]]; setBox(); });
  for (const name of ['pointerup','pointercancel','lostpointercapture']) svg.addEventListener(name,() => drag = null);
  switchMap('knowledge');
})();`;
