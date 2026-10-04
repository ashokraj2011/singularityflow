/** Live checkout disclosure, separate from historical evidence and its decision hash. */
import { changes, exactChangedPathsBetweenObjects, head } from '../git.mjs';
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';

export function evidenceProvenance(root, workflow, evaluatedCommit) {
  const candidates = (workflow.phaseOrder ?? Object.keys(workflow.phases ?? {}))
    .map((id) => ({ phaseId: id, generation: workflow.phases[id]?.generation ?? 0,
      commit: workflow.phases[id]?.generationCommit ?? null }))
    .filter((entry) => entry.commit);
  const warnings = [];
  let currentCommit = null;
  let worktree = 'unknown';
  try {
    currentCommit = head(root);
    const status = changes(root);
    worktree = status.length ? 'dirty' : 'clean';
    if (worktree === 'dirty') warnings.push('Uncommitted changes are not covered by this committed evidence. Publish and validate the changed candidate before treating it as verified.');
    if (currentCommit !== evaluatedCommit) warnings.push('HEAD moved during evaluation. Refresh the matrix before relying on it.');
    const latestCode = candidates.findLast((entry) => phaseRequiresCodeDelivery(workflow.phases[entry.phaseId]));
    if (latestCode && latestCode.commit !== currentCommit) {
      const laterPaths = exactChangedPathsBetweenObjects(root, latestCode.commit, currentCommit)
        .filter((file) => !file.startsWith('singularity/') && !file.startsWith('.github/agents/'));
      if (laterPaths.length) warnings.push(`HEAD contains ${laterPaths.length} changed application path(s) since the latest published code candidate ${latestCode.commit}. Those later commits are not covered by that candidate's test evidence.`);
    }
  } catch {
    warnings.push('Current checkout drift could not be checked; this is historical evidence only.');
  }
  return { evaluatedCommit, currentCommit, worktree, candidates, warnings };
}

export function evidenceProvenanceLines(provenance) {
  if (!provenance) return ['Evaluated revision: unavailable (in-memory evaluation).'];
  return [
    `Evaluated Story revision: ${provenance.evaluatedCommit ?? 'unavailable'}`,
    `Checkout HEAD: ${provenance.currentCommit ?? 'unavailable'}; working tree: ${provenance.worktree}`,
    ...provenance.candidates.map((entry) => `Published candidate ${entry.phaseId} generation ${entry.generation}: ${entry.commit}`),
    ...provenance.warnings.map((warning) => `Warning: ${warning}`)
  ];
}
