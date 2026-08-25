/** Mandatory cross-phase continuity for active requirements, risks and unresolved human requests. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadActiveSpecRecords, predecessorSpecClauses } from './specifications.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { secureRepositoryPath, SingularityFlowError, snapshot } from './util.mjs';
import { authoredArtifactText } from './publication-preflight.mjs';

function strings(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function textSha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function buildActiveClauseCapsule(records, workflow, phase, source = null) {
  if (!workflow || !phase) return { text: '', capsule: null };
  const clauses = predecessorSpecClauses(records, workflow, phase.id)
    .map((clause) => {
      const producer = records.indexes.find((index) => (index.clauses ?? []).some((entry) => entry.id === clause.id));
      // Compatibility for specification indexes created before managed phase inputs were excluded
      // from clause bodies. Preserve the historical index hash as sourceBodySha256 while delivering
      // the same authored-only projection new indexes now persist.
      const projectedBody = authoredArtifactText(clause.body).trim();
      const projected = projectedBody !== clause.body;
      return {
        id: clause.id,
        status: 'active',
        representation: projected ? 'authored-content-projection' : 'verbatim',
        text: projectedBody,
        bodySha256: `sha256:${textSha256(projectedBody)}`,
        ...(projected ? {
          sourceBodySha256: `sha256:${String(clause.bodySha256 ?? '').replace(/^sha256:/, '')}`
        } : {}),
        source: clause.source ?? null,
        sourceSha256: producer?.source?.sha256
          ? `sha256:${String(producer.source.sha256).replace(/^sha256:/, '')}` : null,
        dependencies: [...(clause.dependsOn ?? [])],
        continuityProof: projected ? 'managed-envelope-excluded' : 'present-verbatim'
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const clarifications = (workflow.changeRequests ?? [])
    .filter((entry) => entry.status === 'open' && entry.targetPhase === phase.id)
    .map((entry) => ({ id: entry.id, clauseIds: [...(entry.clauseIds ?? [])], detail: entry.comment }));
  const payload = {
    schemaVersion: 1, // schema-transient: prompt projection, never persisted independently
    workId: workflow.workItem.id,
    phase: phase.id,
    clauses,
    openRisks: strings(source?.risks),
    clarifications
  };
  const capsule = { ...payload, capsuleSha256: `sha256:${recordSha256(payload)}` };
  if (!clauses.length && !capsule.openRisks.length && !clarifications.length) {
    return { text: '', capsule };
  }
  const text = [
    '# Active Clause Capsule',
    '',
    '> Kernel-derived mandatory continuity context. Active producer-authored clause text is carried from generation-bound specification indexes; kernel-managed envelopes are excluded. Do not omit, weaken, or silently supersede it.',
    '',
    '```json',
    canonicalJson(capsule).trimEnd(),
    '```'
  ].join('\n');
  return { text, capsule };
}

function sameDigest(left, right) {
  return String(left ?? '').replace(/^sha256:/, '') === String(right ?? '').replace(/^sha256:/, '');
}

function predecessorIds(workflow, phaseId) {
  const order = Array.isArray(workflow?.phaseOrder)
    ? workflow.phaseOrder
    : Array.isArray(workflow?.resolution?.phases)
      ? workflow.resolution.phases.map((entry) => entry.id).filter(Boolean)
      : [];
  const position = order.indexOf(phaseId);
  return new Set(position < 0 ? [] : order.slice(0, position));
}

async function verifyIndex(root, candidate, workflow) {
  const producer = workflow.phases?.[candidate.phase];
  const anchor = producer?.specIndex;
  const problems = [];
  if (!producer || producer.status !== 'approved') problems.push('producer phase is not approved');
  if (!anchor) problems.push('workflow specIndex anchor is missing');
  if (candidate.workId !== workflow.workItem.id) problems.push('work item does not match');
  if (Number(candidate.generation) !== Number(producer?.generation)) problems.push('generation is stale');
  if (anchor && Number(anchor.generation) !== Number(producer?.generation)) problems.push('anchor generation is stale');

  let anchored = null;
  if (anchor?.path) {
    const target = await secureRepositoryPath(root, anchor.path, {
      label: `Specification index for ${candidate.phase}`, mustExist: true, type: 'file'
    });
    anchored = readRecord('specification-index', await readFile(target.absolute)).record;
    if (canonicalJson(anchored) !== canonicalJson(candidate)) problems.push('loaded index differs from the anchored index file');
  } else if (anchor) problems.push('anchor path is missing');

  const withoutHash = { ...candidate };
  delete withoutHash.indexSha256;
  const computedIndexSha256 = recordSha256(withoutHash);
  if (!sameDigest(candidate.indexSha256, computedIndexSha256)) problems.push('index self-hash is invalid');
  if (anchor && !sameDigest(anchor.indexSha256, computedIndexSha256)) problems.push('index hash does not match the workflow anchor');
  if (anchor && Number(anchor.clauses) !== Number(candidate.clauses?.length ?? 0)) problems.push('clause count does not match the workflow anchor');
  if (anchor && !sameDigest(anchor.sourceSha256, candidate.source?.sha256)) problems.push('source hash does not match the workflow anchor');

  if (!candidate.source?.path) problems.push('source artifact path is missing');
  else {
    const source = await secureRepositoryPath(root, candidate.source.path, {
      label: `Specification source for ${candidate.phase}`, mustExist: true, type: 'file'
    });
    const current = await snapshot(source.absolute);
    const approved = producer?.artifacts?.find((artifact) => artifact.path === source.relative);
    if (!sameDigest(current.sha256, candidate.source.sha256)) problems.push('approved source bytes changed after indexing');
    if (Number(current.size) !== Number(candidate.source.bytes)) problems.push('approved source size changed after indexing');
    if (!approved || approved.status !== 'approved') problems.push('source artifact has no approved workflow record');
    else if (!sameDigest(approved.sha256, current.sha256)) problems.push('source artifact does not match its approved hash');
  }
  if (problems.length) {
    throw new SingularityFlowError(
      `Active Clause Capsule refused unverified ${candidate.phase} specification context:\n- ${problems.join('\n- ')}`,
      { code: 'SPECIFICATION_INDEX_UNTRUSTED', details: { phase: candidate.phase, problems } }
    );
  }
  return candidate;
}

/** Build one deterministic capsule from the current generation's active specification indexes. */
export async function activeClauseCapsule(itemDirectory, workflow, phase, source = null, { root = null } = {}) {
  if (!workflow || !phase) return { text: '', capsule: null };
  if (!root) {
    throw new SingularityFlowError('Active Clause Capsule requires the trusted repository root.', {
      code: 'SPECIFICATION_INDEX_ROOT_REQUIRED'
    });
  }
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const allowed = predecessorIds(workflow, phase.id);
  const indexes = [];
  for (const candidate of records.indexes.filter((index) => allowed.has(index.phase))) {
    indexes.push(await verifyIndex(root, candidate, workflow));
  }
  return buildActiveClauseCapsule({ ...records, indexes }, workflow, phase, source);
}
