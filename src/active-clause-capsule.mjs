/** Mandatory cross-phase continuity for active requirements, risks and unresolved human requests. */
import { loadActiveSpecRecords, predecessorSpecClauses } from './specifications.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';

function strings(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function buildActiveClauseCapsule(records, workflow, phase, source = null) {
  if (!workflow || !phase) return { text: '', capsule: null };
  const clauses = predecessorSpecClauses(records, workflow, phase.id)
    .map((clause) => {
      const producer = records.indexes.find((index) => (index.clauses ?? []).some((entry) => entry.id === clause.id));
      return {
        id: clause.id,
        status: 'active',
        representation: 'verbatim',
        text: clause.body,
        bodySha256: `sha256:${String(clause.bodySha256 ?? '').replace(/^sha256:/, '')}`,
        source: clause.source ?? null,
        sourceSha256: producer?.source?.sha256
          ? `sha256:${String(producer.source.sha256).replace(/^sha256:/, '')}` : null,
        dependencies: [...(clause.dependsOn ?? [])],
        continuityProof: 'present-verbatim'
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
    '> Kernel-derived mandatory continuity context. Every active clause below is carried verbatim from a generation-bound specification index. Do not omit, weaken, or silently supersede it.',
    '',
    '```json',
    canonicalJson(capsule).trimEnd(),
    '```'
  ].join('\n');
  return { text, capsule };
}

/** Build one deterministic capsule from the current generation's active specification indexes. */
export async function activeClauseCapsule(itemDirectory, workflow, phase, source = null) {
  if (!workflow || !phase) return { text: '', capsule: null };
  return buildActiveClauseCapsule(await loadActiveSpecRecords(itemDirectory, workflow), workflow, phase, source);
}
