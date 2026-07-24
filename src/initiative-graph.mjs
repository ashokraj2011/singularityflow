import path from 'node:path';
import { identity } from './git.mjs';
import {
  appendInitiativeRecord, authorityDescription, isAuthorized, readInitiativeRecords
} from './initiative-evidence.mjs';
import { loadInitiative, saveInitiative } from './initiative-state.mjs';
import { SingularityFlowError, nowIso } from './util.mjs';

export function initiativeNode(type, ...parts) {
  return `${type}:${parts.join('/')}`;
}

function addNode(graph, id, value = {}) {
  graph.nodes[id] ??= { id, ...value };
}

function addEdge(graph, from, to, reason) {
  addNode(graph, from);
  addNode(graph, to);
  if (!graph.edges.some((edge) => edge.from === from && edge.to === to && edge.reason === reason)) graph.edges.push({ from, to, reason });
}

export function buildInitiativeGraph(initiative, { evidence = [], approvals = [] } = {}) {
  const graph = { nodes: {}, edges: [] };
  for (const phase of initiative.resolution.phases) {
    const phaseNode = initiativeNode('phase', phase.id);
    addNode(graph, phaseNode, { type: 'phase', phase: phase.id });
    for (const output of phase.outputs) {
      const outputNode = initiativeNode('output', phase.id, output.id);
      addNode(graph, outputNode, { type: 'output', phase: phase.id, output: output.id });
      addEdge(graph, outputNode, phaseNode, 'phase-bundle');
      for (const reference of output.consumes ?? []) {
        const [producerPhase, producerOutput] = reference.split('/');
        addEdge(graph, initiativeNode('output', producerPhase, producerOutput), outputNode, 'declared-input');
      }
    }
    for (const check of phase.checklist) {
      const checkNode = initiativeNode('check', phase.id, check.id);
      addNode(graph, checkNode, { type: 'check', phase: phase.id, check: check.id });
      addEdge(graph, checkNode, phaseNode, 'phase-gate');
    }
  }
  for (const entry of evidence) {
    const record = entry.record;
    const evidenceNode = initiativeNode('evidence', entry.sha256);
    addNode(graph, evidenceNode, { type: 'evidence', sha256: entry.sha256 });
    addEdge(graph, evidenceNode, initiativeNode('check', record.phase, record.check), 'supports-check');
  }
  for (const entry of approvals) {
    const record = entry.record;
    const approvalNode = initiativeNode('approval', entry.sha256);
    addNode(graph, approvalNode, { type: 'approval', sha256: entry.sha256 });
    const subjectNode = record.subject.type === 'phase'
      ? initiativeNode('phase', record.phase)
      : initiativeNode(record.subject.type, record.phase, record.subject.id);
    addEdge(graph, subjectNode, approvalNode, 'approved-subject');
  }
  for (const contract of Object.values(initiative.contracts ?? {})) {
    const contractNode = initiativeNode('contract', contract.id, contract.version);
    addNode(graph, contractNode, { type: 'contract', contractId: contract.id, version: contract.version });
    for (const storyId of contract.consumers ?? []) addEdge(graph, contractNode, initiativeNode('story', storyId), 'contract-consumer');
    for (const storyId of contract.producers ?? []) addEdge(graph, initiativeNode('story', storyId), contractNode, 'contract-producer');
  }
  for (const story of Object.values(initiative.childStories ?? {})) {
    const storyNode = initiativeNode('story', story.id);
    addNode(graph, storyNode, { type: 'story', storyId: story.id, repository: story.repository });
    for (const dependency of story.dependsOn ?? []) {
      const dependencyId = typeof dependency === 'string' ? dependency : dependency.story;
      addEdge(graph, initiativeNode('story', dependencyId), storyNode, 'story-dependency');
    }
    if (story.blocking) {
      for (const phaseId of ['build', 'construction', 'release', 'delivery']) {
        if (initiative.phases?.[phaseId]) addEdge(graph, storyNode, initiativeNode('phase', phaseId), 'blocking-story-milestone');
      }
    }
  }
  return graph;
}

export function downstreamCone(graph, starts) {
  const pending = [...new Set(starts)];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of graph.edges) if (edge.from === current && !visited.has(edge.to)) pending.push(edge.to);
  }
  return [...visited].sort();
}

function markNodeStale(initiative, node, recordSha256) {
  const [type, reference] = node.split(':', 2);
  const parts = reference?.split('/') ?? [];
  if (type === 'output') {
    const output = initiative.phases[parts[0]]?.outputs?.[parts[1]];
    if (output) {
      output.status = 'stale';
      output.invalidatedBy = recordSha256;
    }
  } else if (type === 'phase') {
    const phase = initiative.phases[parts[0]];
    if (phase && phase.status === 'approved') {
      phase.status = 'stale';
      phase.invalidatedBy = recordSha256;
    }
  } else if (type === 'story') {
    const story = initiative.childStories?.[parts[0]];
    if (story) {
      story.stale = true;
      story.invalidatedBy = recordSha256;
    }
  } else if (type === 'contract') {
    const key = `${parts[0]}@${parts[1]}`;
    const contract = initiative.contracts?.[key];
    if (contract) {
      contract.status = 'stale';
      contract.invalidatedBy = recordSha256;
    }
  }
}

function affectedPhaseIds(initiative, affected) {
  const phaseIds = new Set();
  for (const node of affected) {
    const [type, reference] = node.split(':', 2);
    if (!['phase', 'output', 'check'].includes(type)) continue;
    const phaseId = reference?.split('/')[0];
    if (initiative.phases?.[phaseId]) phaseIds.add(phaseId);
  }
  return phaseIds;
}

function rewindInvalidatedLifecycle(initiative, affected, recordSha256, at) {
  const affectedPhases = affectedPhaseIds(initiative, affected);
  if (!affectedPhases.size) return null;
  const currentIndex = initiative.currentPhase == null
    ? initiative.phaseOrder.length
    : initiative.phaseOrder.indexOf(initiative.currentPhase);
  const earliestIndex = initiative.phaseOrder.findIndex((phaseId) => affectedPhases.has(phaseId));
  if (earliestIndex < 0 || earliestIndex > currentIndex) return null;
  const reopenedId = initiative.phaseOrder[earliestIndex];
  for (let index = earliestIndex; index < initiative.phaseOrder.length; index += 1) {
    const phaseId = initiative.phaseOrder[index];
    const phase = initiative.phases[phaseId];
    if (index === earliestIndex) {
      phase.status = 'in_progress';
      phase.startedAt ??= at;
      phase.submittedAt = null;
      phase.approvedAt = null;
      phase.invalidatedBy = recordSha256;
      continue;
    }
    if (phase.status !== 'approved' || affectedPhases.has(phaseId)) {
      phase.status = 'not_started';
      phase.submittedAt = null;
      phase.approvedAt = null;
      if (affectedPhases.has(phaseId)) phase.invalidatedBy = recordSha256;
    }
  }
  initiative.currentPhase = reopenedId;
  initiative.status = 'in_progress';
  return reopenedId;
}

export async function invalidateInitiativeCone(root, {
  initiativeId,
  starts,
  reason,
  cause = 'changed',
  persona = null
} = {}) {
  if (!starts?.length) throw new SingularityFlowError('At least one justification-graph node is required for invalidation.');
  if (!reason?.trim()) throw new SingularityFlowError('Invalidation reason is required.');
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const evidence = await readInitiativeRecords(root, portfolio, initiativeId, 'evidence');
  const approvals = await readInitiativeRecords(root, portfolio, initiativeId, 'approvals');
  const graph = buildInitiativeGraph(initiative, { evidence, approvals });
  for (const node of starts) if (!graph.nodes[node]) throw new SingularityFlowError(`Unknown justification-graph node '${node}'.`);
  const affected = downstreamCone(graph, starts);
  const actor = identity(root);
  const record = {
    schemaVersion: 1,
    type: 'invalidation',
    initiativeId,
    cause,
    starts: [...new Set(starts)].sort(),
    affected,
    reason: reason.trim(),
    actor,
    persona,
    at: nowIso()
  };
  const appended = await appendInitiativeRecord(root, portfolio, initiativeId, 'invalidations', record);
  for (const node of affected) markNodeStale(initiative, node, appended.sha256);
  const reopenedPhase = rewindInvalidatedLifecycle(initiative, affected, appended.sha256, record.at);
  initiative.history.push({
    at: record.at,
    actor: actor.email?.toLowerCase() ?? actor.name,
    persona,
    event: 'initiative_cone_invalidated',
    phase: reopenedPhase,
    detail: `${starts.join(', ')} affected ${affected.length} nodes${reopenedPhase ? ` and reopened ${reopenedPhase}` : ''}: ${reason.trim()}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { ...appended, affected, graph, reopenedPhase };
}

export async function activeInitiativeInvalidations(root, portfolio, initiativeId) {
  return readInitiativeRecords(root, portfolio, initiativeId, 'invalidations');
}

export function nextInitiativePhase(initiative) {
  return initiative.phaseOrder.map((id) => initiative.phases[id]).find((phase) => phase.status !== 'approved') ?? null;
}

function rejectionTarget(initiative, phaseId, subject) {
  const phase = initiative.resolution.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new SingularityFlowError(`Unknown initiative phase '${phaseId}'.`);
  if (subject === 'phase') return { node: initiativeNode('phase', phaseId), policy: phase.bundleApproval, type: 'phase', id: phaseId };
  const output = phase.outputs.find((candidate) => candidate.id === subject);
  if (output) return { node: initiativeNode('output', phaseId, subject), policy: output.approval.mode === 'bundle' ? phase.bundleApproval : output.approval, type: 'output', id: subject };
  const check = phase.checklist.find((candidate) => candidate.id === subject);
  if (check) return { node: initiativeNode('check', phaseId, subject), policy: check.approval.mode === 'bundle' ? phase.bundleApproval : check.approval, type: 'check', id: subject };
  throw new SingularityFlowError(`Unknown rejection subject '${subject}'.`);
}

export async function rejectInitiative(root, {
  initiativeId,
  phaseId = null,
  subject = 'phase',
  reason,
  persona = null,
  channel = 'terminal'
} = {}) {
  if (!reason?.trim()) throw new SingularityFlowError('Initiative rejection reason is required.');
  let loaded = await loadInitiative(root, initiativeId);
  const selectedPhase = phaseId ?? loaded.initiative.currentPhase;
  if (selectedPhase !== loaded.initiative.currentPhase) throw new SingularityFlowError(`Current initiative phase is '${loaded.initiative.currentPhase ?? 'complete'}'.`);
  const phase = loaded.initiative.phases[selectedPhase];
  if (phase.status !== 'awaiting_approval') throw new SingularityFlowError(`Initiative phase '${selectedPhase}' is ${phase.status}; rejection requires awaiting_approval.`);
  const target = rejectionTarget(loaded.initiative, selectedPhase, subject);
  const actor = identity(root);
  if (!isAuthorized(loaded.initiative.resolution, target.policy, actor)) throw new SingularityFlowError(`${actor.email?.toLowerCase() ?? actor.name} is not authorized to reject ${target.type} '${target.id}'. Required authority: ${authorityDescription(target.policy)}.`);
  const decision = {
    schemaVersion: 1,
    type: 'approval',
    decision: 'rejected',
    initiativeId,
    phase: selectedPhase,
    subject: { type: target.type, id: target.id, sha256: null },
    reason: reason.trim(),
    actor,
    identityAssurance: 'configured-local',
    persona,
    channel,
    at: nowIso(),
    selfApproval: false
  };
  const approval = await appendInitiativeRecord(root, loaded.portfolio, initiativeId, 'approvals', decision);
  const invalidation = await invalidateInitiativeCone(root, {
    initiativeId,
    starts: [target.node],
    reason: reason.trim(),
    cause: 'rejected',
    persona
  });
  loaded = await loadInitiative(root, initiativeId);
  const reopened = loaded.initiative.phases[selectedPhase];
  reopened.status = 'in_progress';
  reopened.submittedAt = null;
  reopened.approvedAt = null;
  reopened.rejectedAt = decision.at;
  reopened.rejectionReason = decision.reason;
  loaded.initiative.currentPhase = selectedPhase;
  loaded.initiative.status = 'in_progress';
  loaded.initiative.history.push({
    at: decision.at,
    actor: actor.email?.toLowerCase() ?? actor.name,
    persona,
    event: 'initiative_rejected',
    phase: selectedPhase,
    detail: `${target.type}/${target.id}: ${decision.reason}`
  });
  await saveInitiative(root, loaded.portfolio, loaded.initiative);
  return { ...loaded, approval, invalidation, target };
}
