import { witnessedClauseReviewFields } from './specification-quality.mjs';
import { workDir } from './story-paths.mjs';
import { activeWitnessClauses, witnessClauseStatus } from './specifications.mjs';

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
  // The criteria as `approve` reads them (specifications.mjs activeWitnessClauses): every active index, whatever its record's kind.
  let clauses = new Map();
  try { clauses = await activeWitnessClauses(workDir(root, config, workflow.workItem.id), workflow); } catch { clauses = new Map(); }
  return {
    ...structuredClone(packet.witnessReview ?? {}),
    mappings: mappings.slice(0, 1000).map((mapping) => {
      // Its text whenever it is the criterion it was submitted against; Behavior and Observable only when it states them.
      const status = witnessClauseStatus(mapping, clauses);
      const body = status === 'current' ? clauses.get(mapping.clauseId).body : null;
      return {
        ...structuredClone(mapping),
        clauseText: body,
        clauseFields: body ? witnessedClauseReviewFields(body) : null,
        clauseStatus: status
      };
    })
  };
}

