/** Read-only, bounded graph projections. Edges come only from the engine's exact slice. */
import type { ConfigurationCenterView } from './configuration-center-model.ts';

export interface VisualRecord {
  key: string; label: string; kind: string; status: string; group: string;
  workflow?: string;
  details: Array<[string, string]>;
  references: Array<{ label: string; ref: string }>;
}
export interface VisualNode extends VisualRecord { column: number; }
export interface VisualEdge extends VisualRecord { from: string; to: string; }
export interface VisualGraph {
  id: 'knowledge' | 'calm'; title: string; description: string;
  nodes: VisualNode[]; edges: VisualEdge[]; notices: string[];
  empty: string; workflows: Array<{ id: string; label: string }>;
}
const MAX_NODES = 160;
const MAX_EDGES = 320;
const key = (...parts: string[]) => JSON.stringify(parts);

export function worldModelVisualGraphs(view: ConfigurationCenterView): VisualGraph[] {
  const status = view.worldModelStatus;
  const knowledge: VisualGraph = {
    id: 'knowledge', title: 'World Model',
    description: 'Registered views → configured workflow phases. These links show context routing, not proof that a requirement is satisfied.',
    nodes: [], edges: [], notices: [], workflows: [],
    empty: 'No World Model views are configured. Configure views below; exploring never builds a model.'
  };
  for (const entry of status.views.slice(0, MAX_NODES)) {
    knowledge.nodes.push({
      key: key('view', entry.id), label: entry.id, kind: 'view', group: 'Views', column: 0,
      status: entry.generated ? 'available' : entry.status ?? 'not-generated',
      details: [
        ['Contract', entry.reference], ['Path', entry.path],
        ['Policy', entry.required ? 'Required' : 'Optional'],
        ['View-ledger facts', entry.counts ? String(entry.counts.total) : 'Unknown'],
        ['Fact states', entry.counts ? `${entry.counts.available} available · ${entry.counts.partial} partial · ${entry.counts.unavailable} unavailable · ${entry.counts.contradicted} contradicted · ${entry.counts.stale} stale` : 'Unknown'],
        ['Context use', `${entry.workflowCount} workflows · ${entry.phaseCount} phase assignments`],
        ['Cache', entry.cache ?? 'Unknown']
      ],
      references: entry.expansion.map((ref) => ({ label: ref.kind === 'view' ? 'Open exact view' : `Open ${ref.kind}`, ref: ref.ref }))
    });
  }
  const viewKeys = new Set(knowledge.nodes.map((node) => node.key));
  let omittedPhases = 0;
  let omittedEdges = 0;
  for (const workflow of status.workflows) {
    knowledge.workflows.push({ id: workflow.id, label: workflow.label });
    for (const phase of workflow.phases.filter((row) => row.views.length > 0)) {
      if (knowledge.nodes.length >= MAX_NODES) { omittedPhases += 1; continue; }
      const phaseKey = key('phase', workflow.id, phase.id);
      knowledge.nodes.push({
        key: phaseKey, label: phase.label, kind: 'phase', group: workflow.label, column: 1,
        workflow: workflow.id, status: workflow.mode === 'off' || phase.source === 'disabled' ? 'disabled' : workflow.mode,
        details: [['Workflow', `${workflow.label} (${workflow.id})`], ['Phase', phase.id],
          ['Mode', workflow.mode], ['Depth', phase.depth], ['Policy source', phase.source], ['Views', phase.views.join(', ')]],
        references: []
      });
      // Disabled assignments remain visible, but are never drawn as active injection.
      if (workflow.mode === 'off' || phase.source === 'disabled') continue;
      for (const id of [...new Set(phase.views)]) {
        const from = key('view', id);
        if (!viewKeys.has(from)) { omittedEdges += 1; continue; }
        if (knowledge.edges.length >= MAX_EDGES) { omittedEdges += 1; continue; }
        knowledge.edges.push({
          key: key('assignment', workflow.id, phase.id, id), label: phase.depth, kind: 'context',
          status: phase.source, group: workflow.label, workflow: workflow.id, from, to: phaseKey,
          details: [['View', id], ['Workflow', workflow.label], ['Phase', phase.label],
            ['Depth', phase.depth], ['Policy source', phase.source]], references: []
        });
      }
    }
  }
  if (status.views.length > MAX_NODES || omittedPhases || omittedEdges) knowledge.notices.push(
    `Bounded map: ${knowledge.nodes.length} items and ${knowledge.edges.length} assignments shown; additional configured items are available in the coverage table.`
  );
  if (!status.built) knowledge.notices.push('No built model is available. Declared views are not generated knowledge.');

  const projection = status.projections.find((entry) => entry.id === 'arch.calm');
  const calm: VisualGraph = {
    id: 'calm', title: 'CALM architecture',
    description: 'Components and directed relationships from the published CALM projection. Layout groups are visual only; no relationship is inferred.',
    nodes: [], edges: [], notices: [], workflows: [],
    empty: !projection ? view.worldModel.projections.archCalm.enabled
      ? 'CALM is enabled but has not been generated. Review an explicit World Model build below.'
      : 'CALM is not enabled. Enable Generate CALM architecture in settings, approve the configuration, then build.'
      : `CALM is unavailable: ${projection.refusalCode ?? projection.status}. Inspect the projection diagnostics below.`
  };
  if (!projection || projection.status !== 'available') return [knowledge, calm];
  const refs = projection.expansion ? [{ label: 'Open exact CALM JSON', ref: projection.expansion.ref }] : [];
  const sources = (record: { sources?: Array<{ kind: string; reference: string | null; assurance: string | null }>; sourceCount?: number }) => [
    ...(record.sources ?? []).map((source): [string, string] => [source.kind, `${source.reference ?? 'Exact record'} · ${source.assurance ?? 'Assurance unspecified'}`]),
    ...((record.sourceCount ?? 0) > (record.sources?.length ?? 0)
      ? [['More sources', `${record.sourceCount! - (record.sources?.length ?? 0)} in the exact source map`] as [string, string]] : [])
  ];
  const nodeIds = new Set<string>();
  for (const node of (projection.nodes ?? []).slice(0, MAX_NODES)) {
    if (nodeIds.has(node.id)) { calm.notices.push('Duplicate component identities were omitted from the map. Inspect the exact projection.'); continue; }
    nodeIds.add(node.id);
    const group = node.layer === 'external' ? 'External' : node.layer === 'governance' || node.type === 'actor'
      ? 'Governance' : node.type === 'database' ? 'Data' : 'Delivery';
    calm.nodes.push({
      key: key('component', node.id), label: node.name, kind: node.type, status: node.status, group,
      column: ['Governance', 'Delivery', 'Data', 'External'].indexOf(group),
      details: [['Identity', node.id], ['CALM type', node.type], ['Declared layer', node.layer],
        ['Evidence state', node.status], ['Projection SHA-256', projection.sha256 ?? 'Unknown'], ...sources(node)],
      references: refs
    });
  }
  let missingEndpoints = 0;
  let boundedEdges = 0;
  for (const relation of projection.relationships ?? []) {
    for (const destination of [...new Set(relation.destinations)]) {
      if (!nodeIds.has(relation.source) || !nodeIds.has(destination)) { missingEndpoints += 1; continue; }
      if (calm.edges.length >= MAX_EDGES) { boundedEdges += 1; continue; }
      calm.edges.push({
        key: key('connection', relation.id, relation.source, destination), label: relation.kind,
        kind: relation.kind, status: relation.status, group: 'Connections',
        from: key('component', relation.source), to: key('component', destination),
        details: [['Identity', relation.id], ['Relationship', relation.kind], ['From', relation.source],
          ['To', destination], ['Evidence state', relation.status], ...sources(relation)], references: refs
      });
    }
  }
  if (missingEndpoints) calm.notices.push(`${missingEndpoints} connections have endpoints outside this bounded preview; no placeholder architecture was invented.`);
  if (boundedEdges || projection.truncated?.nodes || projection.truncated?.relationships || (projection.nodes?.length ?? 0) > MAX_NODES) {
    calm.notices.push('Bounded architecture preview. Open exact CALM JSON or the tables for the complete projection.');
  }
  const gaps = projection.counts;
  if (gaps && (gaps.unavailable || gaps.contradictions)) calm.notices.push(
    `${gaps.unavailable} unavailable facts · ${gaps.contradictions} contradictions. See Evidence gaps and contradictions below.`
  );
  calm.notices.push(`${projection.counts?.controls ?? projection.controls?.length ?? 0} controls · ${projection.counts?.flows ?? projection.flows?.length ?? 0} ordered flows are inspectable in the architecture tables; connections here do not imply flow order.`);
  if (!calm.nodes.length) calm.empty = 'The published CALM projection has no component nodes. Inspect its evidence gaps below.';
  return [knowledge, calm];
}

/** Standalone so the identical bounded filtering function also runs in the webview. */
export function selectVisualGraph(graph: VisualGraph, filters: { query: string; group: string; status: string; workflow: string; selected: string | null; neighbors: boolean }) {
  const query = filters.query.trim().toLowerCase();
  const workflowNodes = new Set(graph.nodes.filter((node) => node.workflow === filters.workflow).map((node) => node.key));
  if (filters.workflow) for (const edge of graph.edges) if (edge.workflow === filters.workflow) workflowNodes.add(edge.from);
  const neighborhood = new Set([filters.selected]);
  if (filters.neighbors && filters.selected) for (const edge of graph.edges) {
    if (edge.from === filters.selected) neighborhood.add(edge.to);
    if (edge.to === filters.selected) neighborhood.add(edge.from);
  }
  const nodes = graph.nodes.filter((node) => (!filters.workflow || workflowNodes.has(node.key))
    && (!filters.group || filters.group === node.group) && (!filters.status || filters.status === node.status)
    && (!query || [node.label, node.kind, node.status, ...node.details.flat()].join(' ').toLowerCase().includes(query))
    && (!filters.neighbors || !filters.selected || neighborhood.has(node.key)));
  const keys = new Set(nodes.map((node) => node.key));
  return { nodes, edges: graph.edges.filter((edge) => keys.has(edge.from) && keys.has(edge.to)) };
}

/** Deterministic, cycle-safe columns: placement never treats topology as a dependency DAG. */
export function layoutVisualGraph(nodes: VisualNode[]) {
  const columns = [...new Set(nodes.map((node) => node.column))].sort((a, b) => a - b);
  const placed = nodes.map((node) => ({ ...node, x: 28 + columns.indexOf(node.column) * 310,
    y: 48 + nodes.filter((other) => other.column === node.column).indexOf(node) * 94 }));
  return { nodes: placed, width: Math.max(340, columns.length * 310 + 28),
    height: Math.max(230, 76 + Math.max(0, ...columns.map((column) => nodes.filter((node) => node.column === column).length)) * 94) };
}
