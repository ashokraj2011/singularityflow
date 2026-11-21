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

/** Scope guidance follows verified responsibilities, with the same explicit legacy fallback. */
export function phaseOwnsScope(workflow, phase) {
  if (stepResponsibilities(workflow, phase?.id).includes('scope')) return true;
  return !workflow?.resolution?.obligationGraph
    && phase?.kind !== 'skill' && phase?.skillBinding == null
    && ['requirements', 'implementation-spec'].includes(artifactKindOf(phase));
}

/** The last step on the route that defines the Story's scope: no later step can link a statement after it. */
export function finalScopeStep(workflow) {
  return [...(workflow?.phaseOrder ?? [])].reverse().map((id) => workflow.phases?.[id]).find((phase) => phase && phaseOwnsScope(workflow, phase)) ?? null;
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

/**
 * The source-review kind of one step of a Story: what its start pinned (every authored step, from review
 * level 2: a document step's review is 'document', a code step's 'code'), else its pinned responsibilities.
 */
export function sourceReviewKind(workflow, phaseId) {
  if (!workflow?.phases?.[phaseId]) return null;
  const pinned = workflow.resolution?.sourceReview?.kinds;
  if (pinned && typeof pinned === 'object') return Object.hasOwn(pinned, phaseId) ? pinned[phaseId] : null;
  return reviewKindForResponsibilities(stepResponsibilities(workflow, phaseId));
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

/**
 * Owner-step checks [PHR:REQ-002]: what a later step judges of an earlier step's output, its own step
 * checks first. Pinned at Story start [SPK:CON-039], so a Story already running keeps its policy.
 * Level 2 adds the checks decided after batch 2's first landing (2026-11-10): a failed visual comparison
 * held at the visual step, and an amendment's rows for the clauses it revises. Level 3 (2026-11-20): the last code
 * step's own submission refuses the coverage its approval would (a step with no approval completes there), so the gap
 * is delivered in that step's next version. A Story pinned at a level keeps that level's checks and never meets a later one's.
 */
export const OWNER_STEP_CHECKS = 3;

export function phaseResponsibilityPin() {
  return { ownerStepChecks: OWNER_STEP_CHECKS };
}

/** Whether this Story pinned the owner-step checks when it started, at `level` or later. */
export function ownerStepChecks(workflow, level = 1) {
  return Number(workflow?.resolution?.phaseResponsibility?.ownerStepChecks ?? 0) >= level;
}

// Approve twice (owner, 2026-11-19): which steps may be approved automatically, by structure [E2G-001]. Configuration
// refuses `approval.automatic` elsewhere, and Workflow Studio offers its switch only where it may be on.

/** Whether a step may change source files (a code step always may: configuration holds it to that scope). */
export const editsSource = (phase) => (phase?.writeScope ?? 'artifact-only') === 'source-and-artifact';

const approvedByPeople = (phase) => phase?.approval !== 'none' && (phase?.approval?.mode ?? 'required') !== 'none';

/** The plan: the steps owning a code step's planned claims, or else the last step people approve before the first that edits source. */
export function planStepIds(workType, phases) {
  const owners = Object.values(workType?.plannedClaims?.owners ?? {}).filter((id) => typeof id === 'string');
  if (owners.length) return new Set(owners);
  const first = phases.findIndex(editsSource);
  const plan = first > 0 ? phases.slice(0, first).filter(approvedByPeople).at(-1) : null;
  return new Set(plan ? [plan.id] : []);
}

/**
 * Why `phase` is never approved automatically in this work type ("it is the plan"), or null when it may be.
 * `planSteps` names the plan when the work type's step intents settled it (step-intent-settings.mjs: the planner of
 * each code step); otherwise planStepIds reads it from the work type.
 */
export function automaticApprovalRefusal(phase, { workType = null, phases = [], planSteps = null } = {}) {
  if (!phase) return null;
  if ((planSteps ? new Set(planSteps) : planStepIds(workType, phases)).has(phase.id)) return 'it is the plan, which a person approves';
  if (editsSource(phase)) return 'it may change source files, so a person approves it';
  if (isConvergencePhase(phase)) return 'only a person\'s approval moves the Story on from convergence';
  if (workType?.designSources && (workType.designSources.capturePhase ?? 'design-intake') === phase.id) {
    return 'a person approves which design versions the Story builds on';
  }
  const loop = (workType?.reworkLoops ?? []).find((entry) => entry?.from === phase.id);
  if (loop) return `it can send the work back to ${loop.to}, which a person decides`;
  return null;
}

/** The steps SFlow approved since the last step people approved, before `phaseId`: a person's approval of it covers them. */
export function automaticApprovalsBefore(workflow, phaseId) {
  const order = workflow?.phaseOrder ?? [];
  const covered = [];
  for (let index = order.indexOf(phaseId) - 1; index >= 0; index -= 1) {
    const phase = workflow.phases?.[order[index]];
    if (!phase || phase.status === 'skipped' || (phase.approvalPolicy?.mode ?? 'required') === 'none') continue;
    if (phase.status !== 'approved' || phase.approvalDisposition !== 'approved_automatically' || !phase.automaticApproval) break;
    covered.unshift(phase);
  }
  return covered;
}

/** A covered step as approval screens list it. */
export function coveredStep(phase) {
  return {
    phase: phase.id, label: phase.label ?? phase.id, generation: Number(phase.generation ?? 0),
    reviewPacketSha256: phase.automaticApproval?.reviewPacketSha256 ?? null,
    documents: [...new Set((phase.artifacts ?? []).map((artifact) => artifact?.path).filter((file) => typeof file === 'string' && file))],
    words: `approved automatically: ${(phase.automaticApproval?.checked ?? []).join('; ') || 'its reviewer said ready and nothing was open'}`
  };
}

/**
 * What a step may say about what it is for (step intents spec §3, §7.1): `intent:`, one of these ten words, written on
 * the step itself, and `because:`, the reason for each of these settings the step sets itself rather than taking
 * from its intent (§7.3). Configuration checks both when it loads (config.mjs); the profiles that give each intent
 * its settings are in step-intents.mjs, and step-intent-settings.mjs derives a work type's settings from them when
 * every step says what it is for (workflow.yml version 4). Names still decide nothing: the engine reads the settings.
 * A work type's own `because:` names the work-type settings it sets itself (WORK_TYPE_BECAUSE_SETTINGS).
 */
export const STEP_INTENTS = Object.freeze(['intake', 'requirements', 'design', 'plan', 'code', 'test', 'review', 'release', 'report', 'document']);
export const BECAUSE_SETTINGS = Object.freeze([
  'writeScope', 'sourceBoundary', 'generation', 'generation.task', 'generation.producer', 'generation.requirement', 'artifact.kind',
  'clarification', 'clarification.mode', 'approval', 'approval.mode', 'approval.automatic', 'approval.policy', 'approval.rejectTo',
  'repositoryTests', 'testEvidenceFrom', 'testRuns', 'repairBudget'
]);
export const WORK_TYPE_BECAUSE_SETTINGS = Object.freeze(['plannedClaims', 'plannedClaims.clausePhases', 'plannedClaims.owners', 'sourceReview', 'sourceReview.skip']);
