/**
 * What a phase's approval decided over, as upstream references [E2G-021, decision D16].
 *
 * Each reference names one thing the phase depends on by kind and carries its digest. An approval
 * records them; rework later compares them with the Story as it is (rule E1). A phase depends on:
 * - the phases it declares as inputs, or, when it declares none, every earlier phase: each one's
 *   status, generation, approval and artifact bytes, which is what its phase-input record binds;
 * - once code is delivered at or before it, the application tree at HEAD (everything outside the
 *   governance root) and the specification records: clauses, plans, observed claims and
 *   acceptance runs;
 * - the Story documents offered to it, and the Story's scope, completeness, plan, risk and
 *   applicability decisions.
 * Null for a skill phase, whose inputs are bound by receipts this does not model, or when the
 * repository cannot say what HEAD holds.
 */
import path from 'node:path';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { headTreeDigest } from './git.mjs';
import { resolvedPhaseInputs } from './inputs.mjs';
import { recordSha256 } from './records.mjs';
import { loadActiveSpecRecords } from './specifications.mjs';

/** The Story decisions an evaluation reads; a change to any of them can change what was decided. */
export const STORY_DECISION_LISTS = Object.freeze(['scopeDispositions', 'completenessReviews', 'scopeRevisions', 'planAmendments', 'riskDecisions', 'applicability']);

const digest = (value) => `sha256:${recordSha256(value)}`;

/** One producer as its consumer's phase-input record binds it. */
function producerDigest(phase) {
  return digest({
    status: phase?.status ?? 'missing',
    generation: phase?.generation ?? 0,
    approvedAt: phase?.approvedAt ?? null,
    approvedBy: phase?.approvedBy ?? null,
    artifacts: (phase?.artifacts ?? []).map((artifact) => ({ path: artifact.path, exists: artifact.exists ?? null, sha256: artifact.sha256 ?? null }))
      .sort((left, right) => left.path.localeCompare(right.path))
  });
}

/** Every tracked file at HEAD outside the governance root, or null when HEAD cannot be read. */
function applicationTreeDigest(root, config) {
  return headTreeDigest(root, { excludedRoot: `${String(config.workItemRoot ?? 'singularity/work-items').split('/')[0]}/` });
}

async function offeredDocuments(root, config, workflow, phaseId) {
  const { loadDocumentManifest, evidenceIsActive } = await import('./documents.mjs');
  const { documentOfferedToPhase } = await import('./document-identity.mjs');
  const manifest = await loadDocumentManifest(root, config, workflow);
  return manifest.documents.filter((record) => evidenceIsActive(record) && documentOfferedToPhase(record, phaseId))
    .map((record) => ({ id: record.id, sha256: record.sha256 ?? null, size: record.size ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function phaseUpstream(root, config, workflow, phase) {
  if (workflow.resolution?.phases?.find((entry) => entry.id === phase?.id)?.kind === 'skill') return null;
  const order = workflow.phaseOrder ?? [];
  const index = order.indexOf(phase?.id);
  if (index < 0) return null;
  const refs = [];
  const declared = [...new Set(resolvedPhaseInputs(workflow, phase).map((entry) => entry.phase).filter(Boolean))].sort();
  for (const id of declared.length ? declared : order.slice(0, index)) {
    refs.push({ kind: declared.length ? 'input' : 'phase', ref: id, sha256: producerDigest(workflow.phases[id]) });
  }
  if (order.slice(0, index + 1).some((id) => phaseRequiresCodeDelivery(workflow.phases[id]))) {
    const tree = applicationTreeDigest(root, config);
    if (!tree) return null;
    refs.push({ kind: 'candidate', ref: 'HEAD', sha256: tree });
    const records = await loadActiveSpecRecords(path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id), workflow);
    refs.push({ kind: 'specification', ref: 'records', sha256: digest({
      indexes: records.indexes ?? [], planned: records.planned ?? [], observed: records.observed ?? [], acceptance: records.acceptance ?? []
    }) });
  }
  refs.push({ kind: 'documents', ref: phase.id, sha256: digest(await offeredDocuments(root, config, workflow, phase.id)) });
  refs.push({ kind: 'decisions', ref: 'story', sha256: digest(Object.fromEntries(STORY_DECISION_LISTS.map((key) => [key, workflow[key] ?? null]))) });
  return { sha256: digest(refs), refs };
}

/** Which references differ, named `kind` or `kind:ref`, for saying why a phase runs again. */
export function changedUpstream(decided, current) {
  if (!decided?.refs || !current?.refs) return ['upstream'];
  const key = (ref) => `${ref.kind}:${ref.ref}`;
  const before = new Map(decided.refs.map((ref) => [key(ref), ref.sha256]));
  const after = new Map(current.refs.map((ref) => [key(ref), ref.sha256]));
  const changed = new Set();
  for (const ref of [...decided.refs, ...current.refs]) {
    if (before.get(key(ref)) !== after.get(key(ref))) changed.add(['input', 'phase'].includes(ref.kind) ? key(ref) : ref.kind);
  }
  return [...changed];
}
