/**
 * The workflow graph, drawn as SVG.
 *
 * No library, and that is a decision rather than an omission. The extension has zero runtime
 * dependencies; these graphs are seven nodes and nineteen edges; and the layout is already computed
 * in `workflow-graph-model.ts`. Pulling in React and a canvas library to place nineteen lines would
 * add two idioms and several hundred kilobytes to buy pan and zoom on a diagram that fits on screen.
 *
 * The webview CSP is `default-src 'none'` with nonce'd styles, so everything here is inline markup
 * and no script runs at all — which is the right shape for something read-only.
 *
 * Colours come from VS Code's own theme variables so the diagram inherits light, dark and
 * high-contrast without three palettes.
 */
import type { WorkflowGraph } from './workflow-graph-model.ts';

const NODE_WIDTH = 150;
const NODE_HEIGHT = 46;
const LAYER_GAP = 78;
const SLOT_GAP = 22;
const PADDING = 20;

function escape(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] as string
  ));
}

interface Placed { x: number; y: number; }

/** Where each node sits. Layers run top to bottom; slots spread across a layer and are centred. */
function positions(graph: WorkflowGraph): Map<string, Placed> {
  const widest = Math.max(1, ...graph.nodes.map((node) => node.slots));
  const canvasWidth = widest * NODE_WIDTH + (widest - 1) * SLOT_GAP;
  const placed = new Map<string, Placed>();
  for (const node of graph.nodes) {
    const rowWidth = node.slots * NODE_WIDTH + (node.slots - 1) * SLOT_GAP;
    const left = PADDING + (canvasWidth - rowWidth) / 2;
    placed.set(node.id, {
      x: left + node.slot * (NODE_WIDTH + SLOT_GAP),
      y: PADDING + node.depth * (NODE_HEIGHT + LAYER_GAP)
    });
  }
  return placed;
}

/**
 * An edge from the bottom of one node to the top of another.
 *
 * Rework edges run backwards — upward — so they are drawn as a curve out to the side rather than a
 * straight line through the nodes between them. A straight backward line crosses every intervening
 * phase and reads as a connection to each of them.
 */
function edgePath(from: Placed, to: Placed, backward: boolean): string {
  const startX = from.x + NODE_WIDTH / 2;
  const endX = to.x + NODE_WIDTH / 2;
  if (!backward) {
    const startY = from.y + NODE_HEIGHT;
    const endY = to.y;
    const midY = (startY + endY) / 2;
    return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
  }
  // Out to the right, up, and back in — clear of everything it passes.
  const startY = from.y + NODE_HEIGHT / 2;
  const endY = to.y + NODE_HEIGHT / 2;
  const lane = Math.max(startX, endX) + NODE_WIDTH / 2 + 34;
  return `M ${startX + NODE_WIDTH / 2} ${startY} C ${lane} ${startY}, ${lane} ${endY}, ${endX + NODE_WIDTH / 2} ${endY}`;
}

export function renderWorkflowGraph(graph: WorkflowGraph | null, { compact = false } = {}): string {
  if (!graph) return '<p class="graph-empty">This work type declares no phases to draw.</p>';
  const placed = positions(graph);
  const widest = Math.max(1, ...graph.nodes.map((node) => node.slots));
  const width = PADDING * 2 + widest * NODE_WIDTH + (widest - 1) * SLOT_GAP + 90;
  const height = PADDING * 2 + graph.depth * NODE_HEIGHT + (graph.depth - 1) * LAYER_GAP;

  const edges = graph.edges.map((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) return '';
    const backward = edge.kind === 'rework';
    return `<path d="${edgePath(from, to, backward)}" class="edge ${backward ? 'rework' : 'input'}"
      marker-end="url(#arrow-${backward ? 'rework' : 'input'})"><title>${escape(edge.from)} ${backward ? 'can reject to' : 'feeds'} ${escape(edge.to)}</title></path>`;
  }).join('');

  const nodes = graph.nodes.map((node) => {
    const at = placed.get(node.id)!;
    const parents = graph.edges.filter((edge) => edge.kind === 'input' && edge.to === node.id).map((edge) => edge.from);
    const tooltip = [
      node.label,
      parents.length ? `Needs: ${parents.join(', ')}` : 'Starts the workflow',
      node.canRedo ? 'Can be rejected back to itself' : null,
      node.isolated ? 'Not connected to any other phase' : null
    ].filter(Boolean).join('\n');
    return `<g class="node${node.isolated ? ' isolated' : ''}">
      <rect x="${at.x}" y="${at.y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="7"/>
      <text x="${at.x + NODE_WIDTH / 2}" y="${at.y + (compact ? 27 : 21)}">${escape(node.label)}</text>
      ${compact ? '' : `<text class="sub" x="${at.x + NODE_WIDTH / 2}" y="${at.y + 35}">${escape(node.id)}</text>`}
      <title>${escape(tooltip)}</title>
    </g>`;
  }).join('');

  // A cycle should be impossible, so if one is ever drawn the reader is told rather than left to
  // trust a diagram of a workflow that cannot run.
  const warning = graph.cycle
    ? `<p class="graph-warning">These phases depend on each other in a loop and cannot all run: ${escape(graph.cycle.join(' → '))}.</p>`
    : '';

  return `${warning}<svg class="workflow-graph" viewBox="0 0 ${width} ${height}" width="100%"
    preserveAspectRatio="xMidYMin meet" role="img"
    aria-label="${escape(`${graph.label}: ${graph.nodes.length} phases, ${graph.edges.length} dependencies`)}">
    <defs>
      <marker id="arrow-input" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 8 4 L 0 8 z" class="arrow input"/>
      </marker>
      <marker id="arrow-rework" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 8 4 L 0 8 z" class="arrow rework"/>
      </marker>
    </defs>
    ${edges}${nodes}
  </svg>`;
}

/** The style block, kept beside the markup it styles rather than in whichever page embeds it. */
export const WORKFLOW_GRAPH_STYLES = `
  .workflow-graph { display:block; max-width:100%; height:auto; }
  .workflow-graph .node rect {
    fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border); stroke-width:1;
  }
  .workflow-graph .node.isolated rect { stroke-dasharray:4 3; }
  .workflow-graph .node text {
    fill: var(--vscode-foreground); font-size:12px; text-anchor:middle; font-weight:600;
  }
  .workflow-graph .node text.sub {
    fill: var(--vscode-descriptionForeground); font-size:10px; font-weight:400;
  }
  .workflow-graph .edge { fill:none; stroke-width:1.4; }
  /* A dependency is the structure; a rework path is the exception — so it is dashed and quieter. */
  .workflow-graph .edge.input { stroke: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  .workflow-graph .edge.rework {
    stroke: var(--vscode-descriptionForeground); stroke-dasharray:5 4; opacity:.75;
  }
  .workflow-graph .arrow.input { fill: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  .workflow-graph .arrow.rework { fill: var(--vscode-descriptionForeground); }
  .graph-warning {
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
    border-left:3px solid var(--vscode-errorForeground); padding:6px 10px; margin:0 0 10px;
  }
  .graph-empty { color: var(--vscode-descriptionForeground); }
  @media (forced-colors: active) {
    .workflow-graph .node rect { fill:Canvas; stroke:CanvasText; }
    .workflow-graph .node text { fill:CanvasText; }
    .workflow-graph .edge.input, .workflow-graph .arrow.input { stroke:LinkText; fill:LinkText; }
    .workflow-graph .edge.rework, .workflow-graph .arrow.rework { stroke:CanvasText; fill:CanvasText; }
  }
`;
