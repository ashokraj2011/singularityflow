import path from 'node:path';

import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { validateChangeRegionManifest } from './contracts.mjs';

export const CMP_EXPLANATION_SUBJECTS = Object.freeze([
  'clause', 'file', 'symbol', 'change', 'refusal', 'generation', 'test'
]);

const MAXIMUM_GRAPH_NODES = 5000;
const MAXIMUM_GRAPH_EDGES = 5000;
const MAXIMUM_QUERY_RESULTS = 500;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function sha256(value) {
  return `sha256:${recordSha256(value)}`;
}

function compare(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function causeIdentity(cause) {
  return `${cause?.causeKind ?? ''}\0${cause?.causeId ?? ''}`;
}

function causeNodeId(cause) {
  return `cause:${cause.causeKind}:${cause.causeId}`;
}

function regionNodeId(region) {
  return `region:${region.regionSha256}`;
}

function handle(graphSha256, nodeId) {
  return `cmp_${recordSha256({ graphSha256, nodeId }).slice(0, 24)}`;
}

function queryPath(value) {
  const source = String(value ?? '').trim();
  const portable = source.replaceAll('\\', '/');
  const comparable = portable.replace(/^\.\/+/, '');
  const normalized = path.posix.normalize(comparable);
  if (!source || source.length > 4096 || source.includes('\0')
      || normalized === '.' || normalized === '..' || normalized.startsWith('../')
      || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(source)
      || normalized !== comparable || comparable.includes('//')) {
    throw new SingularityFlowError('Comprehension file queries require one normalized repository-relative path.', {
      code: 'CMP_EXPLANATION_QUERY_INVALID'
    });
  }
  return normalized;
}

function queryValue(type, value) {
  const source = String(value ?? '').trim();
  if (!CMP_EXPLANATION_SUBJECTS.includes(type)) {
    throw new SingularityFlowError(
      `Unknown comprehension explanation subject '${type ?? ''}'. Use ${CMP_EXPLANATION_SUBJECTS.join(', ')}.`,
      { code: 'CMP_EXPLANATION_QUERY_INVALID' }
    );
  }
  if (type === 'file') return queryPath(source);
  if (!source || source.length > 512 || source.includes('\0')) {
    throw new SingularityFlowError(`Comprehension ${type} queries require one bounded identifier.`, {
      code: 'CMP_EXPLANATION_QUERY_INVALID'
    });
  }
  return source;
}

/**
 * Build a deterministic read-only graph from the already-validated observe-only CMP assessment.
 * Invalid or ambiguous bindings never become edges. The result is a projection, not a store or
 * publication authority.
 */
export function buildComprehensionGraph({ manifest, coverage, bindings = [], causes = [] } = {}) {
  const manifestValidation = validateChangeRegionManifest(manifest);
  const coverageCore = coverage && typeof coverage === 'object'
    ? Object.fromEntries(Object.entries(coverage).filter(([key]) => key !== 'resultSha256'))
    : null;
  if (!manifestValidation.valid
      || coverage?.kind !== 'comprehension-coverage-result'
      || coverage.resultSha256 !== sha256(coverageCore)
      || coverage.candidateSha256 !== manifest.compatibilityCandidateSha256) {
    throw new SingularityFlowError('The comprehension graph requires one exact evaluated manifest and coverage result.', {
      code: 'CMP_GRAPH_INTEGRITY_INVALID'
    });
  }
  const validBindings = new Set((coverage.bindingResults ?? [])
    .filter((entry) => entry.valid === true && SHA256.test(String(entry.bindingSha256 ?? '')))
    .map((entry) => entry.bindingSha256));
  const fullCauses = new Map();
  const causeCandidates = [
    ...causes,
    ...bindings.flatMap((binding) => (binding?.causeRefs ?? [])
      .filter((reference) => reference?.kind === 'cause-ref'))
  ];
  for (const cause of causeCandidates) {
    const identity = causeIdentity(cause);
    const byRecord = fullCauses.get(identity) ?? new Map();
    byRecord.set(cause.refSha256 ?? sha256(cause), cause);
    fullCauses.set(identity, byRecord);
  }
  const regionNodes = manifest.regions.map((region) => ({
    id: regionNodeId(region),
    type: 'change-region',
    regionId: region.regionId,
    regionSha256: region.regionSha256,
    pathBefore: region.location?.pathBefore ?? null,
    pathAfter: region.location?.pathAfter ?? null,
    operation: region.operation,
    assurance: region.classification?.assurance ?? 'unavailable'
  }));
  const causeNodes = new Map();
  const edges = [];
  for (const binding of bindings) {
    if (!validBindings.has(binding?.bindingSha256)) continue;
    const region = manifest.regions.find((entry) => entry.regionSha256 === binding.regionSha256);
    if (!region) continue;
    for (const reference of binding.causeRefs ?? []) {
      const matches = [...(fullCauses.get(causeIdentity(reference))?.values() ?? [])];
      const cause = matches.length === 1 ? matches[0] : null;
      if (!cause || reference.recordSha256 !== cause.authority?.recordSha256) continue;
      const nodeId = causeNodeId(cause);
      causeNodes.set(nodeId, {
        id: nodeId,
        type: 'cause',
        causeKind: cause.causeKind,
        causeId: cause.causeId,
        statement: cause.statement,
        statementSha256: cause.statementSha256,
        authorityRecordSha256: cause.authority.recordSha256,
        authorityStatus: cause.authority.status
      });
      edges.push({
        id: `edge:${binding.bindingSha256}:${nodeId}:${region.regionSha256}`,
        type: 'cause-to-change-region',
        from: nodeId,
        to: regionNodeId(region),
        relationship: binding.relationship,
        bindingSha256: binding.bindingSha256,
        confirmationDecisionSha256: binding.confirmation?.decisionSha256 ?? null
      });
    }
  }
  const nodes = [...causeNodes.values(), ...regionNodes]
    .sort((left, right) => compare(left.type, right.type) || compare(left.id, right.id));
  edges.sort((left, right) => compare(left.from, right.from)
    || compare(left.to, right.to) || compare(left.bindingSha256, right.bindingSha256));
  if (nodes.length > MAXIMUM_GRAPH_NODES || edges.length > MAXIMUM_GRAPH_EDGES) {
    throw new SingularityFlowError(
      `The comprehension graph exceeds its ${MAXIMUM_GRAPH_NODES}-node or ${MAXIMUM_GRAPH_EDGES}-edge read ceiling.`,
      { code: 'CMP_GRAPH_LIMIT' }
    );
  }
  const core = {
    schemaVersion: 1, // schema-transient: read-only CMP graph projection; never persisted
    kind: 'comprehension-intent-graph',
    authoritative: false,
    authority: 'unverified-observation',
    lifecycleGate: false,
    candidateBinding: manifest.candidateBinding,
    candidateSha256: manifest.compatibilityCandidateSha256,
    manifestSha256: manifest.manifestSha256,
    coverageResultSha256: coverage.resultSha256,
    nodes,
    edges,
    counts: {
      nodes: nodes.length,
      causes: causeNodes.size,
      regions: regionNodes.length,
      edges: edges.length
    },
    availability: {
      causeGraph: edges.length ? 'available' : 'unavailable',
      structure: 'unavailable',
      structureReason: 'resource-fallback-no-ast-required',
      durableAuthority: 'unavailable'
    },
    diagnosticCodes: [...new Set((coverage.diagnostics ?? []).map((entry) => entry.code))].sort()
  };
  return freezeDeep({ ...core, graphSha256: sha256(core) });
}

function related(graph, seedIds) {
  const ids = new Set(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (ids.has(edge.from) || ids.has(edge.to)) {
        if (!ids.has(edge.from)) { ids.add(edge.from); changed = true; }
        if (!ids.has(edge.to)) { ids.add(edge.to); changed = true; }
      }
    }
  }
  const nodes = graph.nodes.filter((node) => ids.has(node.id)).slice(0, MAXIMUM_QUERY_RESULTS);
  const admitted = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => admitted.has(edge.from) && admitted.has(edge.to))
    .slice(0, MAXIMUM_QUERY_RESULTS);
  return {
    nodes,
    edges,
    truncated: ids.size > nodes.length || graph.edges.filter(
      (edge) => ids.has(edge.from) && ids.has(edge.to)
    ).length > edges.length
  };
}

/** Bidirectional exact query over a deterministic graph. Unsupported sources remain unavailable. */
export function explainComprehensionGraph(graph, { type, value } = {}) {
  if (graph?.kind !== 'comprehension-intent-graph'
      || graph.graphSha256 !== sha256(Object.fromEntries(
        Object.entries(graph).filter(([key]) => key !== 'graphSha256')
      ))) {
    throw new SingularityFlowError('The comprehension graph failed its content-integrity check.', {
      code: 'CMP_GRAPH_INTEGRITY_INVALID'
    });
  }
  const normalized = queryValue(type, value);
  let seeds = [];
  let unavailableReason = null;
  if (type === 'clause') {
    seeds = graph.nodes.filter((node) => node.type === 'cause'
      && ['acceptance-clause', 'requirement'].includes(node.causeKind)
      && node.causeId === normalized)
      .map((node) => node.id);
  } else if (type === 'file') {
    seeds = graph.nodes.filter((node) => node.type === 'change-region'
      && (node.pathAfter === normalized || node.pathBefore === normalized)).map((node) => node.id);
  } else if (type === 'change') {
    seeds = graph.nodes.filter((node) => node.type === 'change-region'
      && (node.regionId === normalized || node.regionSha256 === normalized)).map((node) => node.id);
  } else if (type === 'symbol') {
    unavailableReason = 'CMP_STRUCTURE_UNAVAILABLE';
  } else {
    unavailableReason = 'CMP_EXPLANATION_SOURCE_UNAVAILABLE';
  }
  const matches = related(graph, seeds);
  const status = seeds.length ? 'available' : 'unavailable';
  const core = {
    schemaVersion: 1, // schema-transient: read-only explanation projection; never persisted
    kind: 'comprehension-explanation',
    authoritative: false,
    authority: 'unverified-observation',
    lifecycleGate: false,
    graphSha256: graph.graphSha256,
    query: { type, value: normalized },
    status,
    reasonCode: status === 'available'
      ? null
      : unavailableReason ?? 'CMP_EXPLANATION_SUBJECT_UNAVAILABLE',
    nodes: matches.nodes.map((node) => ({ ...node, handle: handle(graph.graphSha256, node.id) })),
    edges: matches.edges,
    counts: { nodes: matches.nodes.length, edges: matches.edges.length },
    truncated: matches.truncated,
    availability: graph.availability
  };
  return freezeDeep({ ...core, explanationSha256: sha256(core) });
}
