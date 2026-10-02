/**
 * Which responsibilities a workflow step holds [E2G-001, E2G-002].
 *
 * Derived from the step's structure, never from its name, so a renamed copy of a step owes exactly
 * what the original owed:
 *
 * - scope: the step defines requirement clauses (an authoritative clause phase).
 * - plan: the step plans the claims a later code step must meet, or its output is a delivery plan. In
 *   a work type with no code step there are no claims to plan, so the step that defines the scope
 *   also lists the planned changes.
 * - implement: the step delivers code, or may write repository source at all.
 * - verify: the step produces test evidence (a code step runs its tests at submission).
 * - review: the step's output needs an approval.
 *
 * `complete` is the kernel's duty at every endpoint, so no step holds it.
 */
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { isSpecificationDefinitionPhase } from '../specifications.mjs';

const VERIFY_ARTIFACT_KINDS = new Set(['test-evidence', 'visual-test-evidence']);
const PLAN_ARTIFACT_KINDS = new Set(['delivery-plan', 'implementation-plan']);

function approvalOf(phase) {
  return phase?.approvalPolicy ?? phase?.approval ?? null;
}

function artifactKind(phase) {
  return phase?.requiredArtifact?.kind ?? phase?.artifact?.kind ?? null;
}

/** How a step's review is given: by a person, by a configured policy, or not at all. */
export function reviewKind(phase) {
  const approval = approvalOf(phase);
  if (!approval || approval === 'none' || approval.mode === 'none') return null;
  return approval.mode === 'policy' ? 'policy' : 'human';
}

/** The responsibilities one resolved step holds, in the closed vocabulary's order. */
export function phaseResponsibilities(phase, { plannedClaims = null, hasCodeStep = true } = {}) {
  const held = new Set();
  const definesClauses = plannedClaims?.mode === 'required'
    ? (plannedClaims.clausePhases ?? []).includes(phase.id)
    : artifactKind(phase) != null && isSpecificationDefinitionPhase(phase);
  if (definesClauses) held.add('scope');
  if (Object.values(plannedClaims?.owners ?? {}).includes(phase.id) || PLAN_ARTIFACT_KINDS.has(artifactKind(phase))
      || (!hasCodeStep && definesClauses)) held.add('plan');
  const code = phaseRequiresCodeDelivery(phase);
  if (code || phase.writeScope === 'source-and-artifact') held.add('implement');
  if (code || VERIFY_ARTIFACT_KINDS.has(artifactKind(phase)) || phase.testEvidenceFrom) held.add('verify');
  if (reviewKind(phase)) held.add('review');
  return ['scope', 'plan', 'implement', 'verify', 'review'].filter((name) => held.has(name));
}
