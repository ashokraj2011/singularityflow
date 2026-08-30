import type { SgosProcessGraph } from './sgos-process-graph-model.ts';

function escape(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const WIDTH = 190;
const HEIGHT = 68;
const X_GAP = 48;
const Y_GAP = 28;
const PAD = 22;

function stateClass(state: string): string {
  if (state === 'succeeded') return 'ok';
  if (['failed', 'blocked', 'recovery-required'].includes(state)) return 'bad';
  if (['running', 'verifying', 'waiting-human'].includes(state)) return 'active';
  return 'idle';
}

export function renderSgosProcessGraph(graph: SgosProcessGraph | null): string {
  if (!graph) return '<p class="muted">Select a Process to load its exact task graph.</p>';
  const layers = new Map<number, typeof graph.nodes>();
  for (const node of graph.nodes) layers.set(node.layer, [...(layers.get(node.layer) ?? []), node]);
  for (const nodes of layers.values()) nodes.sort((left, right) => left.taskTemplateId.localeCompare(right.taskTemplateId));
  const widest = Math.max(1, ...[...layers.values()].map((nodes) => nodes.length));
  const depth = Math.max(1, ...graph.nodes.map((node) => node.layer + 1));
  const width = PAD * 2 + depth * WIDTH + Math.max(0, depth - 1) * X_GAP;
  const height = PAD * 2 + widest * HEIGHT + Math.max(0, widest - 1) * Y_GAP;
  const placed = new Map<string, { x: number; y: number }>();
  for (const [layer, nodes] of layers) {
    const columnHeight = nodes.length * HEIGHT + Math.max(0, nodes.length - 1) * Y_GAP;
    const start = PAD + (height - PAD * 2 - columnHeight) / 2;
    nodes.forEach((node, index) => placed.set(node.taskTemplateId, {
      x: PAD + layer * (WIDTH + X_GAP), y: start + index * (HEIGHT + Y_GAP)
    }));
  }
  const edges = graph.edges.map((edge) => {
    const from = placed.get(edge.from); const to = placed.get(edge.to);
    if (!from || !to) return '';
    const x1 = from.x + WIDTH; const y1 = from.y + HEIGHT / 2;
    const x2 = to.x; const y2 = to.y + HEIGHT / 2;
    const bend = Math.max(16, (x2 - x1) / 2);
    return `<path class="sgos-edge" d="M${x1} ${y1} C${x1 + bend} ${y1},${x2 - bend} ${y2},${x2} ${y2}" marker-end="url(#sgos-arrow)"/>`;
  }).join('');
  const nodes = graph.nodes.map((node) => {
    const point = placed.get(node.taskTemplateId)!;
    return `<g class="sgos-node ${stateClass(node.state)}" transform="translate(${point.x} ${point.y})">
      <rect width="${WIDTH}" height="${HEIGHT}" rx="6"/>
      <text x="12" y="25">${escape(node.taskTemplateId)}</text>
      <text class="sub" x="12" y="48">${escape(node.state)} · revision ${node.revision}</text>
    </g>`;
  }).join('');
  const warning = graph.cycle.length
    ? `<p class="warning-text" role="alert">The exact Program contains a cycle involving ${escape(graph.cycle.join(', '))}.</p>` : '';
  return `${warning}<div class="sgos-graph-wrap"><svg class="sgos-graph" viewBox="0 0 ${width} ${height}"
    role="img" aria-labelledby="sgos-graph-title sgos-graph-description">
    <title id="sgos-graph-title">Process ${escape(graph.processId)} task graph</title>
    <desc id="sgos-graph-description">${graph.nodes.length} tasks and ${graph.edges.length} dependencies. A complete text table follows.</desc>
    <defs><marker id="sgos-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>
    ${edges}${nodes}
  </svg></div>`;
}

export const SGOS_GRAPH_STYLES = `
  .sgos-graph-wrap { width:100%; overflow:auto; border:var(--sf-border); border-radius:var(--sf-radius); background:var(--sf-surface); }
  .sgos-graph { display:block; min-width:36rem; width:100%; height:auto; }
  .sgos-edge { fill:none; stroke:var(--vscode-descriptionForeground); stroke-width:1.4; }
  .sgos-graph marker path { fill:var(--vscode-descriptionForeground); }
  .sgos-node rect { fill:var(--vscode-editorWidget-background); stroke:var(--sf-border-color); stroke-width:1.5; }
  .sgos-node.ok rect { stroke:var(--sf-ok); }
  .sgos-node.bad rect { stroke:var(--sf-bad); }
  .sgos-node.active rect { stroke:var(--sf-wait); stroke-width:2; }
  .sgos-node text { fill:var(--vscode-foreground); font:600 12px var(--vscode-font-family); }
  .sgos-node text.sub { fill:var(--vscode-descriptionForeground); font-weight:400; font-size:10px; }
  @media (forced-colors:active) {
    .sgos-node rect { fill:Canvas; stroke:CanvasText; }
    .sgos-node text, .sgos-node text.sub { fill:CanvasText; }
    .sgos-edge { stroke:CanvasText; }
    .sgos-graph marker path { fill:CanvasText; }
  }
`;
