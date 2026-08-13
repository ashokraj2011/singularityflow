/**
 * A workflow as the graph it already is.
 *
 * `workflow.yml` has always carried a DAG and no surface has ever drawn it. A phase declares
 * `inputs: [requirements, design]` — two parents — and `conformance` declares three. A tree or an
 * ordered list can show one of those relationships and silently drops the rest, because a list has
 * exactly one predecessor per item and the model does not.
 *
 * So this is not decoration. It renders a dependency structure the existing views are structurally
 * incapable of expressing, and it reads it from `definition.workTypes.<id>.phaseOverrides[].inputs`
 * — the same field the engine folds — rather than inferring order from the phase array.
 *
 * Pure and free of `vscode` on purpose: layout is arithmetic, and arithmetic should be testable
 * without an extension host.
 */
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export interface GraphNode {
  id: string;
  label: string;
  /** Layer: how many phases must complete before this one can start. */
  depth: number;
  /** Position within the layer, and the layer's size, so a renderer can centre them. */
  slot: number;
  slots: number;
  /** Present in the profile's phase list but never named as anyone's input, and naming no inputs. */
  isolated: boolean;
  /**
   * This phase can be rejected back to itself — "redo it here" rather than "return to an earlier
   * phase". True for most phases, which is exactly why it is a node property and not an edge: drawn
   * as fifteen self-loops it would bury the eleven edges that carry the actual structure.
   */
  canRedo: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  /**
   * `input` is a dependency the phase declares. `rework` is an `approval.rejectTo` target — an edge
   * that runs backwards through the lifecycle, and the reason this cannot be drawn as a plain
   * left-to-right chain.
   */
  kind: 'input' | 'rework';
}

export interface WorkflowGraph {
  workTypeId: string;
  label: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Layer count, so a caller can size a canvas without walking the nodes. */
  depth: number;
  /**
   * A cycle in the input edges. The engine's phase order is linear, so this should never happen;
   * if configuration ever produces one, the layout must still terminate and the reader must be told
   * rather than shown a plausible drawing of an impossible workflow.
   */
  cycle: string[] | null;
}

function phaseLabel(snapshot: RepositorySnapshot, id: string): string {
  const phases = (snapshot.definition?.phases ?? {}) as Record<string, { label?: string }>;
  return phases[id]?.label ?? id;
}

/**
 * Longest-path layering.
 *
 * A node sits one layer below its deepest input, which is what makes a phase with two parents
 * appear after *both* of them rather than after whichever happened to be processed first. Shortest
 * path would draw `implementation-spec` beside `design`, implying they can run together, which is
 * exactly the misreading this view exists to prevent.
 */
function layer(nodes: string[], edges: GraphEdge[]): { depth: Map<string, number>; cycle: string[] | null } {
  const inputs = new Map<string, string[]>(nodes.map((id) => [id, []]));
  for (const edge of edges) {
    if (edge.kind === 'input' && inputs.has(edge.to)) inputs.get(edge.to)!.push(edge.from);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const path: string[] = [];
  let cycle: string[] | null = null;

  const resolve = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) {
      // Record the loop once and stop descending, so a malformed configuration cannot hang the view.
      cycle ??= [...path.slice(path.indexOf(id)), id];
      return 0;
    }
    visiting.add(id);
    path.push(id);
    const parents = inputs.get(id) ?? [];
    const value = parents.length ? Math.max(...parents.map((parent) => resolve(parent) + 1)) : 0;
    path.pop();
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };

  for (const id of nodes) resolve(id);
  return { depth, cycle };
}

/** Build the graph for one work type, or null when the snapshot does not describe it. */
export function buildWorkflowGraph(snapshot: RepositorySnapshot | null, workTypeId: string): WorkflowGraph | null {
  const workTypes = (snapshot?.definition?.workTypes ?? {}) as Record<string, {
    label?: string;
    phases?: string[];
    phaseOverrides?: Record<string, { inputs?: Array<string | { phase?: string }>; approval?: { rejectTo?: string[] } }>;
  }>;
  const workType = workTypes[workTypeId];
  if (!workType?.phases?.length) return null;

  const ids = workType.phases;
  const known = new Set(ids);
  const overrides = workType.phaseOverrides ?? {};
  const phases = (snapshot?.definition?.phases ?? {}) as Record<string, { inputs?: Array<string | { phase?: string }>; approval?: { rejectTo?: string[] } }>;
  const edges: GraphEdge[] = [];
  const redoable = new Set<string>();

  for (const id of ids) {
    // A work type's override replaces the phase's own inputs; that is the same precedence the
    // engine folds with, and reading it differently here would draw a graph nobody runs.
    const declared = overrides[id]?.inputs ?? phases[id]?.inputs ?? [];
    for (const entry of declared) {
      const from = typeof entry === 'string' ? entry : entry?.phase;
      // An input naming a phase this work type does not run is not drawn: the edge exists in
      // configuration but not in this workflow, and drawing it would invent a node.
      if (from && known.has(from)) edges.push({ from, to: id, kind: 'input' });
    }
    const rejectTo = overrides[id]?.approval?.rejectTo ?? phases[id]?.approval?.rejectTo ?? [];
    for (const target of rejectTo) {
      // A self-reference is "redo this phase", recorded on the node. Only a reject that moves the
      // work somewhere else is a transition worth drawing.
      if (target !== id && known.has(target)) edges.push({ from: id, to: target, kind: 'rework' });
      if (target === id) redoable.add(id);
    }
  }

  const { depth, cycle } = layer(ids, edges);
  const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));

  // Group by layer so each node knows its slot, which is all a renderer needs to place it.
  const byDepth = new Map<number, string[]>();
  for (const id of ids) {
    const value = depth.get(id) ?? 0;
    byDepth.set(value, [...(byDepth.get(value) ?? []), id]);
  }

  const nodes: GraphNode[] = ids.map((id) => {
    const value = depth.get(id) ?? 0;
    const peers = byDepth.get(value) ?? [id];
    return {
      id,
      label: phaseLabel(snapshot as RepositorySnapshot, id),
      depth: value,
      slot: peers.indexOf(id),
      slots: peers.length,
      isolated: !connected.has(id),
      canRedo: redoable.has(id)
    };
  });

  return {
    workTypeId,
    label: workType.label ?? workTypeId,
    nodes,
    edges,
    depth: Math.max(0, ...nodes.map((node) => node.depth)) + 1,
    cycle
  };
}

/** Every work type the snapshot can draw, in declaration order. */
export function graphableWorkTypes(snapshot: RepositorySnapshot | null): string[] {
  const workTypes = (snapshot?.definition?.workTypes ?? {}) as Record<string, { phases?: string[] }>;
  return Object.entries(workTypes).filter(([, workType]) => workType?.phases?.length).map(([id]) => id);
}
