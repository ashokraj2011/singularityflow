/**
 * What a workflow step is for, read from its structure and never from its name [E2G-001].
 *
 * A step's id is the author's word for it, and a renamed copy of a step must be governed exactly
 * like the original. Every rule that used to ask "is this the step called convergence?" asks one of
 * these questions instead, so renaming a step changes nothing about how it is governed and naming a
 * step after a packaged one confers nothing.
 *
 * Pure and import-free: it reads Story state (`requiredArtifact`), a resolved definition or raw
 * configuration (`artifact`) alike, so the engine, Workflow Studio and simulation agree.
 */

/** The artifact kind of the engine's convergence report: the step a person reviews to advance. */
export const CONVERGENCE_ARTIFACT_KIND = 'convergence-report';

/** The kind of a step's required artifact, from Story state, a resolved definition or configuration. */
export function artifactKindOf(phase) {
  return phase?.requiredArtifact?.kind ?? phase?.artifact?.kind ?? null;
}

/**
 * The convergence step: the engine reconciles the specification, the plan, the code and its tests
 * into one report, and only an explicit human advancement and approval move the Story past it.
 */
export function isConvergencePhase(phase) {
  return artifactKindOf(phase) === CONVERGENCE_ARTIFACT_KIND;
}

/** A Story's convergence step: the active one when it is a convergence step, otherwise the first. */
export function convergencePhaseOf(workflow) {
  const current = workflow?.phases?.[workflow?.currentPhase];
  if (isConvergencePhase(current)) return current;
  for (const id of workflow?.phaseOrder ?? []) {
    if (isConvergencePhase(workflow.phases?.[id])) return workflow.phases[id];
  }
  return null;
}

/** The responsibilities one step of a Story holds, as the obligation graph pinned at its start says. */
export function stepResponsibilities(workflow, phaseId) {
  return workflow?.resolution?.obligationGraph?.nodes?.find((node) => node.id === phaseId)?.responsibilities ?? [];
}

/** The latest step before `phaseId` in the Story's order that passes `test`, or null. */
export function latestStepBefore(workflow, phaseId, test) {
  const order = workflow?.phaseOrder ?? [];
  const end = order.indexOf(phaseId);
  for (let index = (end < 0 ? order.length : end) - 1; index >= 0; index -= 1) {
    const phase = workflow.phases?.[order[index]];
    if (phase && test(phase)) return phase;
  }
  return null;
}
