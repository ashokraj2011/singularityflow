/** One read-only Convergence action, shared by readiness and every user-facing handoff. */
import { isConvergencePhase } from './phase-roles.mjs';

export function convergenceTransitionRoute(workflow, phase, { needsGeneration = false } = {}) {
  if (!isConvergencePhase(phase) || phase.status !== 'in_progress') return null;
  if (needsGeneration) return {
    classification: 'generation-required', lifecycleReady: false,
    reasonCode: 'PHASE_GENERATION_REQUIRED', skill: '/sflow-converge',
    command: `singularity-flow prepare ${phase.id}`,
    reason: 'Compute a fresh deterministic Convergence projection before publication or advancement.'
  };
  const publications = (phase.generationPublications ?? []).filter((entry) => Number(entry?.generation) === phase.generation);
  const publication = publications.length === 1 ? publications[0] : null;
  const relative = publication?.record?.path;
  const recorded = typeof relative === 'string' && relative.length <= 4096
    && !relative.includes('\\') && !relative.startsWith('/') && !/^[A-Za-z]:/u.test(relative)
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
    && /^sha256:[a-f0-9]{64}$/u.test(publication?.record?.sha256 ?? '');
  if (!recorded) return {
    classification: 'publication-record-missing', lifecycleReady: false,
    reasonCode: 'PHASE_PUBLICATION_RECORD_MISSING', skill: '/sflow-recover',
    command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
    reason: 'Repair the missing publication record before requesting exact Convergence review; a soft sequence exception cannot replace it.'
  };
  return {
    classification: 'convergence-advance-required', lifecycleReady: true,
    reasonCode: 'CONVERGENCE_ADVANCE_REQUIRED', skill: '/sflow-submit',
    command: `singularity-flow story advance --work-id ${workflow.workItem.id}`,
    reason: 'Review the exact deterministic Convergence result and confirm its digest before human approval.'
  };
}
