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

/** The artifact kind of a conformance report: the final account of every clause against the code. */
export const CONFORMANCE_ARTIFACT_KIND = 'conformance-report';

/** The artifact kind of visual verification evidence: screens checked against declared profiles. */
export const VISUAL_EVIDENCE_ARTIFACT_KIND = 'visual-test-evidence';

const TEST_EVIDENCE_KINDS = new Set(['test-evidence', VISUAL_EVIDENCE_ARTIFACT_KIND]);
// Read-side interpretation, installed only after the accepted closure has been verified. It is
// deliberately not serialized into a Story, copied into a pin, or read from caller-provided flags.
const acceptedKinds = new WeakMap();
const acceptedResponsibilities = new WeakMap();

/** Internal boundary used by the verified execution-catalog reader. */
export function bindAcceptedPhaseInterpretation(workflow, kinds, responsibilities) {
  for (const [id, kind] of Object.entries(kinds)) {
    if (workflow.phases?.[id]) acceptedKinds.set(workflow.phases[id], kind);
  }
  acceptedResponsibilities.set(workflow, responsibilities);
}

function interpretedKind(phase) {
  return phase && acceptedKinds.has(phase) ? acceptedKinds.get(phase) : artifactKindOf(phase);
}

/** The kind of a step's required artifact, from Story state, a resolved definition or configuration. */
export function artifactKindOf(phase) {
  return phase?.requiredArtifact?.kind ?? phase?.artifact?.kind ?? null;
}

/**
 * The convergence step: the engine reconciles the specification, the plan, the code and its tests
 * into one report, and only an explicit human advancement and approval move the Story past it.
 */
export function isConvergencePhase(phase) {
  return interpretedKind(phase) === CONVERGENCE_ARTIFACT_KIND;
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
  return acceptedResponsibilities.get(workflow)?.[phaseId]
    ?? workflow?.resolution?.obligationGraph?.nodes?.find((node) => node.id === phaseId)?.responsibilities ?? [];
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

/**
 * What a source review of a step checks: a step that defines the scope is reviewed as a
 * specification, one that plans the claims as a plan, and any other step has no source review.
 */
export function reviewKindForResponsibilities(responsibilities = []) {
  if (responsibilities.includes('scope')) return 'specification';
  if (responsibilities.includes('plan')) return 'planning';
  return null;
}

/** The source-review kind of one step of a Story, from its pinned responsibilities. */
export function sourceReviewKind(workflow, phaseId) {
  return workflow?.phases?.[phaseId] ? reviewKindForResponsibilities(stepResponsibilities(workflow, phaseId)) : null;
}

/** The id of the step that defines a Story's scope: the first step that holds it, whatever it is called. */
function scopeStepIdOf(workflow) {
  return (workflow?.phaseOrder ?? []).find((id) => stepResponsibilities(workflow, id).includes('scope')) ?? null;
}

/** The step that defines a Story's scope. */
export function scopeStepOf(workflow) {
  const id = scopeStepIdOf(workflow);
  return id ? workflow.phases?.[id] ?? null : null;
}

/**
 * Any active step may propose a reviewed amendment to its approved scope. This is a kernel
 * capability, not a work-type opt-in: no convergence finding or configured rework loop is needed.
 * Before scope approval, edit/review its draft instead; closed or cancelled Stories must use their
 * ordinary reopen route. A proposal never approves itself or silently changes pinned policy.
 */
export function intentAmendmentSource(workflow, phaseId = workflow?.currentPhase) {
  const scope = scopeStepOf(workflow);
  const phase = workflow?.phases?.[phaseId];
  const order = workflow?.phaseOrder ?? [];
  return Boolean(scope && phase && phaseId === workflow.currentPhase
    && !['completed', 'complete', 'cancelled', 'archived'].includes(workflow.status)
    && scope.status === 'approved' && Number(scope.generation) >= 1
    && ['in_progress', 'awaiting_approval'].includes(phase.status)
    && order.indexOf(phaseId) > order.indexOf(scope.id)
    && order.includes(scope.id));
}

/** A step whose output is a conformance report, whatever it is called. */
export function isConformancePhase(phase) {
  return interpretedKind(phase) === CONFORMANCE_ARTIFACT_KIND;
}

/** Every conformance step of a Story, in order. */
export function conformancePhasesOf(workflow) {
  return (workflow?.phaseOrder ?? []).map((id) => workflow.phases?.[id]).filter(isConformancePhase);
}

/** A Story's final conformance step: the last one in order. */
export function conformancePhaseOf(workflow) {
  return conformancePhasesOf(workflow).filter((phase) => phase.status !== 'skipped').at(-1) ?? null;
}

/** A step that verifies screens against declared profiles, whatever it is called. */
export function isVisualVerificationPhase(phase) {
  return interpretedKind(phase) === VISUAL_EVIDENCE_ARTIFACT_KIND;
}

/** A Story's visual verification step, or null. */
export function visualVerificationPhaseOf(workflow, phaseId = workflow?.currentPhase) {
  if (phaseId && isVisualVerificationPhase(workflow.phases?.[phaseId])) return workflow.phases[phaseId];
  const phases = (workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {}))
    .map((id) => workflow.phases?.[id]).filter((phase) => isVisualVerificationPhase(phase) && phase.status !== 'skipped');
  // Older pins may have multiple stages. Never silently borrow one stage's evidence for another.
  return phases.length === 1 ? phases[0] : null;
}

/** A step whose output is test evidence, the record that the change was verified. */
export function isTestEvidencePhase(phase) {
  return TEST_EVIDENCE_KINDS.has(interpretedKind(phase));
}
