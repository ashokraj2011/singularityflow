import { run } from './util.mjs';
import { extractClauses } from './specifications.mjs';
import { witnessedClauseReviewFields } from './specification-quality.mjs';

export async function witnessMappingReview(root, config, workflow, phase) {
  const submission = [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) =>
    entry.phase === phase.id && Number(entry.generation) === Number(phase.generation));
  if (!submission) return null;
  const { readStoryReviewPacket } = await import('./story-lineage.mjs');
  const packet = await readStoryReviewPacket(root, config, workflow, submission.packetSha256);
  const mappings = packet.witnessReview?.clauseMappings ?? [];
  if (!mappings.length) return {
    ...structuredClone(packet.witnessReview ?? {}), mappings: []
  };
  const clauses = new Map();
  for (const producer of Object.values(workflow.phases ?? {})) {
    for (const artifact of producer.artifacts ?? []) {
      if (!['requirements', 'implementation-spec'].includes(artifact.kind)) continue;
      try {
        const historical = run('git', ['show', `${packet.evidenceCommit}:${artifact.path}`], {
          cwd: root, allowFailure: true
        });
        if (historical.status !== 0) continue;
        const content = historical.stdout;
        for (const clause of extractClauses(content, { sourcePath: artifact.path })) {
          clauses.set(clause.id, clause);
        }
      } catch { /* Missing or malformed clauses remain visibly unavailable below. */ }
    }
  }
  return {
    ...structuredClone(packet.witnessReview ?? {}),
    mappings: mappings.slice(0, 1000).map((mapping) => {
      const clause = clauses.get(mapping.clauseId);
      const currentBodySha256 = clause?.bodySha256 ? `sha256:${clause.bodySha256}` : null;
      return {
        ...structuredClone(mapping),
        clauseText: currentBodySha256 === mapping.clauseBodySha256 ? clause.body : null,
        clauseFields: currentBodySha256 === mapping.clauseBodySha256
          ? witnessedClauseReviewFields(clause.body) : null,
        clauseStatus: currentBodySha256 === mapping.clauseBodySha256 ? 'current' : 'stale-or-unavailable'
      };
    })
  };
}

