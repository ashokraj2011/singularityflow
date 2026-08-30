import type { SgosProcessCard } from '../cli/snapshot.ts';

export interface SgosGraphTask {
  taskInstanceId: string;
  taskTemplateId: string;
  state: string;
  revision: number;
  receiptSha256: string | null;
}

export interface SgosGraphEdge { from: string; to: string; condition?: unknown }

export interface SgosProcessGraphResult {
  processId: string;
  processRevision: number;
  processSha256: string;
  programId: string;
  programSha256: string;
  tasks: SgosGraphTask[];
  edges: SgosGraphEdge[];
}

export interface SgosGraphNode extends SgosGraphTask { layer: number }
export interface SgosProcessGraph {
  processId: string;
  processSha256: string;
  programId: string;
  nodes: SgosGraphNode[];
  edges: SgosGraphEdge[];
  cycle: string[];
}

/** Refuse a graph from any Process revision except the exact selected card. */
export function buildSgosProcessGraph(
  result: SgosProcessGraphResult | null,
  selected: SgosProcessCard | null
): SgosProcessGraph | null {
  if (!result || !selected || result.processId !== selected.processId
      || result.processSha256 !== selected.processSha256
      || result.processRevision !== selected.processRevision) return null;
  const tasks = [...result.tasks].sort((left, right) => left.taskTemplateId.localeCompare(right.taskTemplateId));
  const ids = new Set(tasks.map((task) => task.taskTemplateId));
  const edges = result.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const incoming = new Map(tasks.map((task) => [task.taskTemplateId, 0]));
  const outgoing = new Map(tasks.map((task) => [task.taskTemplateId, [] as string[]]));
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const layer = new Map<string, number>();
  const visited: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    visited.push(id);
    const current = layer.get(id) ?? 0;
    for (const target of [...(outgoing.get(id) ?? [])].sort()) {
      layer.set(target, Math.max(layer.get(target) ?? 0, current + 1));
      const next = (incoming.get(target) ?? 1) - 1;
      incoming.set(target, next);
      if (next === 0) queue.push(target);
    }
    queue.sort();
  }
  const cycle = tasks.map((task) => task.taskTemplateId).filter((id) => !visited.includes(id));
  return {
    processId: result.processId,
    processSha256: result.processSha256,
    programId: result.programId,
    nodes: tasks.map((task) => ({ ...task, layer: layer.get(task.taskTemplateId) ?? 0 })),
    edges,
    cycle
  };
}
