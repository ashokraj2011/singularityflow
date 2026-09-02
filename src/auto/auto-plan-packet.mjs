/** Deterministic AUT v2 Plan validation and human-ratification packet projections. */
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';

export const AUTO_PLAN_CONFIRMATION_PROTOCOL = 'packet-v2';

function digestRecord(value, field) {
  const record = structuredClone(value);
  record[field] = `sha256:${recordSha256(record)}`;
  return Object.freeze(record);
}

export function buildAutoPlanValidation(plan) {
  const requiredQuestions = [...(plan.proposal?.unresolvedDecisions ?? [])];
  const unhashedPlan = structuredClone(plan);
  delete unhashedPlan.planSha256;
  const exactPlanHash = `sha256:${recordSha256(unhashedPlan)}`;
  const checks = [
    { id: 'exact-plan-hash', status: plan.planSha256 === exactPlanHash ? 'passed' : 'failed' },
    { id: 'governed-story-rail', status: Array.isArray(plan.story?.phaseRail) && plan.story.phaseRail.length ? 'passed' : 'failed' },
    { id: 'managed-worktree', status: plan.executionHost?.containment?.managedWorktree === true ? 'passed' : 'failed' },
    { id: 'start-safety', status: plan.safety?.startable ? 'passed' : 'failed' }
  ];
  const status = !plan.safety?.startable || checks.some((entry) => entry.status === 'failed')
    ? 'invalid'
    : requiredQuestions.length || plan.humanBoundaries?.firstPhaseClarificationRequired
      ? 'needs-human'
      : 'valid';
  return digestRecord({
    schemaVersion: currentSchemaVersion('auto-plan-validation'),
    kind: 'auto-plan-validation',
    planSha256: plan.planSha256,
    status,
    checks,
    warnings: [...(plan.proposal?.assumptions ?? [])],
    requiredQuestions,
    requiredHumanStops: structuredClone(plan.humanBoundaries?.stopPoints ?? []),
    insertedControls: [
      'exact-packet-confirmation', 'managed-worktree', 'ordinary-story-lifecycle',
      'protected-path-halt', 'single-authoring-attempt'
    ]
  }, 'validationSha256');
}

export function buildAutoPlanPacket(plan, validation = buildAutoPlanValidation(plan)) {
  return digestRecord({
    schemaVersion: currentSchemaVersion('auto-plan-packet'),
    kind: 'auto-plan-packet',
    mode: 'auto',
    planId: plan.planId,
    planSha256: plan.planSha256,
    validationSha256: validation.validationSha256,
    requirement: structuredClone(plan.requirement),
    story: structuredClone(plan.story),
    workflow: { phases: [...(plan.story?.phaseRail ?? [])] },
    scope: {
      predictedRead: [...(plan.proposal?.predictedPaths ?? [])],
      predictedWrite: [...(plan.proposal?.predictedPaths ?? [])],
      protected: [...(plan.scope?.protectedPaths ?? [])],
      forbidden: ['governance-policy', 'approval', 'waiver', 'unplanned-external-effect']
    },
    execution: {
      profile: plan.execution?.profile?.resolved ?? 'story',
      executionUnit: plan.executionHost?.id ?? null,
      pacing: plan.execution?.pace?.source ?? null,
      until: plan.execution?.until?.source ?? null,
      repairPolicy: plan.execution?.repair?.policy ?? 'ask',
      repairAttemptsPerPhase: plan.execution?.repair?.maximumAttempts ?? 0
    },
    humanStops: structuredClone(plan.humanBoundaries?.stopPoints ?? []),
    evidence: [...(plan.proposal?.acceptanceCriteria ?? [])],
    budgets: structuredClone(plan.execution?.ceilings ?? {})
  }, 'packetSha256');
}
