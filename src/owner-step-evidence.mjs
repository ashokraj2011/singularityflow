/**
 * What the Story's ending judges of a code step's own criteria, judged at that step's approval
 * [PHR:REQ-002]. The final evaluation refused a criterion whose own test did not verify it, or whose
 * inspection nobody gave, when the step that delivered it was long approved and its author had moved
 * on. The same evaluation, read here for the rows this step answers for, holds its approval instead,
 * where its author can still correct the test and its approvers can still decide.
 *
 * Only for a Story that pinned the owner-step checks at start; loaded only when a code step is approved.
 */
import { evidenceGraphFromAggregate } from './evidence/graph.mjs';
import { evaluateEvidence } from './evidence/evaluate.mjs';
import { ownerStepChecks } from './phase-roles.mjs';
import { SingularityFlowError } from './util.mjs';

const HELD = new Set(['failed', 'inconclusive', 'missing']);
// A criterion's own tests did not verify it [E2G-016, E2G-017]: contract-results.mjs's per-witness findings.
const CRITERION_TEST_FINDING = /^EVIDENCE_(?:TEST_|TESTS_SKIPPED$|ASSURANCE_SHORTFALL$|WITNESS_MISSING$|WITNESS_NOT_APPLICABLE$|TAG_NOT_ON_TEST$)/u;

/** The final evaluation as it stands now, or null when its records cannot be trusted yet (the ending reads it again). */
export async function ownerStepEvaluation(root, config, workflow) {
  const graph = await evidenceGraphFromAggregate(root, config, workflow);
  return graph.untrusted ? null : evaluateEvidence(graph, { boundary: 'approval', mode: 'decision' });
}

/**
 * Each criterion this step answers for whose verify obligation the ending would refuse for `codes`:
 * the step that delivered its tests, else the steps that implement it, last of them. A criterion a
 * later code step also tests is that step's to answer for.
 */
export function ownCriterionFindings(evaluation, phaseId, codes) {
  const held = [];
  for (const row of evaluation?.rows ?? []) {
    const verify = (row.obligations ?? []).find((entry) => entry.responsibility === 'verify');
    if (!verify || !HELD.has(verify.status) || verify.facets?.freshness === 'stale') continue;
    const implement = (row.obligations ?? []).find((entry) => entry.responsibility === 'implement');
    const owners = verify.owningSteps?.length ? verify.owningSteps : implement?.owningSteps ?? [];
    if (owners.at(-1) !== phaseId) continue;
    const findings = (row.findings ?? []).filter((entry) => entry.blocking !== false && codes.test(entry.code)
      && (entry.obligationIds ?? []).includes(verify.id));
    if (!findings.length) continue;
    held.push({ clauseId: row.id, obligationId: verify.id, status: verify.status,
      findings: findings.map((entry) => ({ code: entry.code, message: entry.message })),
      riskCommand: (row.actions ?? []).find((entry) => entry.kind === 'accept-risk' && entry.command.includes(verify.id))?.command ?? null });
  }
  return held;
}

/**
 * The approval refusal for a code step whose own criteria its tests did not verify, or null [PHR:REQ-002],
 * finding 11. Its author corrects the tests in a returned generation; its approvers may instead accept
 * a dated risk on the criterion, as the ending would let them.
 */
export function criterionTestRefusal(workflow, phase, evaluation) {
  if (!ownerStepChecks(workflow)) return null;
  const held = ownCriterionFindings(evaluation, phase.id, CRITERION_TEST_FINDING);
  if (!held.length) return null;
  const workId = workflow.workItem.id;
  const repairCommand = `singularity-flow reject ${phase.id} --work-id ${workId} --fetch --reason <REASON>`;
  return new SingularityFlowError(
    `Phase '${phase.id}' cannot be approved while ${held.length} criterion(s) it delivered are not verified by their own tests:\n- `
    + held.map((entry) => entry.findings.map((finding) => finding.message).join(' ')).join('\n- ')
    + `\n${phase.id}'s author corrects each test (tag the test that verifies the criterion, and make its command run it) in a returned generation; `
    + 'or a person who may accept risk on the criterion records a dated risk. The Story\'s ending refuses the same rows.',
    { code: 'CRITERION_TESTS_UNVERIFIED', details: { workId, phase: phase.id, ownerPhase: phase.id, criteria: held.slice(0, 20),
      findings: held.flatMap((entry) => entry.findings.map((finding) => ({ ...finding, clauseId: entry.clauseId }))).slice(0, 20),
      repairCommand, recoveryCommands: [...new Set(held.map((entry) => entry.riskCommand).filter(Boolean))].slice(0, 5)
        .map((command) => ({ command, label: 'Or a person who may accept this risk records it, with its category and expiry.' })) } }
  );
}

/** Code approval: the step's own criteria, judged as the ending will judge them. */
export async function assertOwnCriteriaVerified(root, config, workflow, phase) {
  if (!ownerStepChecks(workflow)) return;
  const refusal = criterionTestRefusal(workflow, phase, await ownerStepEvaluation(root, config, workflow));
  if (refusal) throw refusal;
}
