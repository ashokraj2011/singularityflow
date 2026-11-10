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
import { terminalEvidenceDecisions } from './evidence/terminal.mjs';
import { decisionListRoute } from './upstream-routes.mjs';
import { activeWitnessDeferral, witnessDeferralCandidates } from './witness-deferrals.mjs';
import { ownerStepChecks, visualVerificationPhaseOf } from './phase-roles.mjs';
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

/**
 * Each sign-off this step answers for that the ending would refuse as missing: an inspection of a criterion it
 * delivers last; a visual sign-off where it is the visual verification step, which captures the screens, or the
 * code step that delivers the criterion on a route with none [PHR:REQ-007]; and any inspection or visual sign-off
 * deferred to it (witness-deferrals.mjs). Slot by slot, from the same evaluation the ending runs.
 */
export function ownSignOffs(evaluation, workflow, phaseId) {
  const held = [];
  const visualStep = visualVerificationPhaseOf(workflow, null)?.id ?? null;
  for (const row of evaluation?.rows ?? []) {
    if (row.type !== 'AC') continue;
    const verify = (row.obligations ?? []).find((entry) => entry.responsibility === 'verify');
    if (!verify || !HELD.has(verify.status) || verify.facets?.freshness === 'stale') continue;
    const implement = (row.obligations ?? []).find((entry) => entry.responsibility === 'implement');
    const owners = verify.owningSteps?.length ? verify.owningSteps : implement?.owningSteps ?? [];
    for (const slot of row.verification?.contract?.slots ?? []) {
      if (slot.role !== 'primary' || !['inspection', 'visual'].includes(slot.method) || !HELD.has(slot.status)) continue;
      const deferral = activeWitnessDeferral(workflow, row.id, slot.slot);
      const owner = slot.method === 'visual' ? visualStep ?? owners.at(-1) : owners.at(-1);
      if ((deferral ? deferral.to : owner) !== phaseId) continue;
      held.push({ clauseId: row.id, slot: slot.slot, method: slot.method, status: slot.status, obligationId: verify.id,
        ...(deferral ? { deferredFrom: deferral.from, deferral: deferral.id } : {}),
        findings: [{ code: slot.method === 'inspection' ? 'EVIDENCE_INSPECTION_MISSING' : 'EVIDENCE_VISUAL_MISSING',
          message: `${row.id}'s ${slot.method} sign-off of slot ${slot.slot} has no witness${deferral ? ` (deferred here from ${deferral.from}, ${deferral.id})` : ''}.` }],
        riskCommand: (row.actions ?? []).find((entry) => entry.kind === 'accept-risk' && entry.command.includes(verify.id))?.command ?? null });
    }
  }
  return held;
}

/**
 * The approval refusal for a step with a sign-off it answers for and nobody gave, or null [PHR:REQ-002, REQ-006],
 * finding 12. Whoever approves the step witnesses it (the ending asked the same people, after the step was long
 * approved): with this approval itself, or as its own sign-off in the decision list, after looking at the file.
 * One of them may instead defer it to a later step that can perform and repair it (decision witness-defer), or a
 * person who may accept risk on the criterion records a dated risk.
 */
export function inspectionWitnessRefusal(workflow, phase, evaluation) {
  if (!ownerStepChecks(workflow)) return null;
  const held = ownSignOffs(evaluation, workflow, phase.id);
  if (!held.length) return null;
  const workId = workflow.workItem.id;
  const clauses = new Set(held.map((entry) => entry.clauseId));
  const witnesses = terminalEvidenceDecisions(workId, { rows: (evaluation?.rows ?? []).filter((row) => clauses.has(row.id)) }, workflow)
    .flatMap((entry) => entry.witnesses.filter((witness) => held.some((slot) => slot.clauseId === entry.criterion && slot.slot === witness.slot)));
  const defer = held.map((entry) => ({ entry, to: witnessDeferralCandidates(workflow, { from: phase.id, method: entry.method })[0] }))
    .filter(({ to }) => to).slice(0, 2)
    .map(({ entry, to }) => ({ command: `singularity-flow decision witness-defer ${workId} --criterion ${entry.clauseId} --slot ${entry.slot} --to ${to} --reason <why>`,
      label: `Or have ${to}, which can perform and repair it, give this sign-off at its own approval.` }));
  const list = decisionListRoute(workId);
  return new SingularityFlowError(
    `Phase '${phase.id}' cannot be approved while ${held.length} sign-off(s) it answers for have no witness:\n- `
    + held.map((entry) => entry.findings.map((finding) => finding.message).join(' ')).join('\n- ')
    + `\nAn approver of ${phase.id} looks at each file and confirms it, with this approval (--confirm-evidence) or as a sign-off in the decision list; `
    + 'or defers it to a later step that can perform and repair it; or a person who may accept risk on the criterion records a dated risk. '
    + 'The Story\'s ending refuses the same rows.',
    { code: 'EVIDENCE_INSPECTION_MISSING', details: { workId, phase: phase.id, ownerPhase: phase.id, criteria: held.slice(0, 20),
      nextAction: { command: list.command, skill: list.skill, label: `An approver of ${phase.id} signs off each one after looking at its file.` },
      recoveryCommands: [
        { command: `singularity-flow approve ${phase.id} --work-id ${workId} --confirm-evidence`, label: 'Or confirm each file with the approval itself, in your own terminal.' },
        ...witnesses.slice(0, 3).map((witness) => ({ command: witness.command, label: 'Or sign it off on its own.' })),
        ...defer,
        ...[...new Set(held.map((entry) => entry.riskCommand).filter(Boolean))].slice(0, 3)
          .map((command) => ({ command, label: 'Or a person who may accept this risk records it, with its category and expiry.' }))] } }
  );
}

/**
 * The approval refusal for a step whose own criteria have evidence from before a scope revision, or null
 * [PHR:REQ-007]: the ending counts it again only once the step runs again, which its author does in a returned
 * generation, here, rather than at the ending after the step was long approved.
 */
export function staleEvidenceRefusal(workflow, phase, evaluation) {
  if (!ownerStepChecks(workflow)) return null;
  const held = [];
  for (const row of evaluation?.rows ?? []) {
    const finding = (row.findings ?? []).find((entry) => entry.code === 'EVIDENCE_STALE_AFTER_SCOPE_REVISION' && entry.blocking !== false);
    if (!finding) continue;
    const owners = (row.obligations ?? []).filter((entry) => (finding.obligationIds ?? []).includes(entry.id))
      .map((entry) => (entry.owningSteps ?? []).at(-1));
    if (owners.includes(phase.id)) held.push({ clauseId: row.id, findings: [{ code: finding.code, message: finding.message }] });
  }
  if (!held.length) return null;
  const workId = workflow.workItem.id;
  return new SingularityFlowError(
    `Phase '${phase.id}' cannot be approved while ${held.length} criterion(s) it delivered have evidence from before a scope revision:\n- `
    + held.map((entry) => entry.findings[0].message).join('\n- ')
    + `\n${phase.id}'s author runs the step again in a returned generation, so its evidence answers the revised clauses. The Story's ending refuses the same rows.`,
    { code: 'EVIDENCE_STALE_AFTER_SCOPE_REVISION', details: { workId, phase: phase.id, ownerPhase: phase.id, criteria: held.slice(0, 20),
      repairCommand: `singularity-flow reject ${phase.id} --work-id ${workId} --fetch --reason <REASON>` } }
  );
}

/** A step's approval: its own criteria and sign-offs, judged as the ending will judge them. */
export async function assertOwnCriteriaVerified(root, config, workflow, phase) {
  if (!ownerStepChecks(workflow)) return;
  const evaluation = await ownerStepEvaluation(root, config, workflow);
  const refusal = criterionTestRefusal(workflow, phase, evaluation) ?? staleEvidenceRefusal(workflow, phase, evaluation)
    ?? inspectionWitnessRefusal(workflow, phase, evaluation);
  if (refusal) throw refusal;
}
