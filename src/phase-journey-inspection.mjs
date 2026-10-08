/** Shared preflight for CLI, Copilot and IDE. No execution, consent or evidence invention. */
import { phasePrepublish } from './phase-prepublish.mjs';
import { phaseDraftCheck } from './phase-draft-check.mjs';
import { recoveryPlan } from './collaboration.mjs';
import { inspectPhaseQualityGate } from './phase-quality-risk.mjs';
import { artifactQualityStatus } from './phase-artifact-risk.mjs';
import { inspectPhaseAuthoredReviewContent } from './publication-preflight.mjs';
import { phaseAppealStatus, assertPhaseAppealsResolved } from './phase-appeals.mjs';
import { loadSession } from './session.mjs';
import { phaseRepairLoopSummary } from './phase-repair-journal.mjs';
import { requiresProspectivePhaseInspection } from './code-submission-evidence.mjs';
import { submissionReadiness } from './submission-readiness.mjs';
import { phaseJourney } from './phase-journey.mjs';
import { evidenceGraphFromAggregate } from './evidence/graph.mjs';
import { evaluateEvidence } from './evidence/evaluate.mjs';
import { mergedVerificationContracts } from './verification/contracts.mjs';
import { plannedClaimsForObservedPhase } from './specifications.mjs';
import { WITNESS_CHECKLIST } from './verification/witness-records.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';

export async function phaseWitnessObligations(root, config, workflow, phase) {
  const graph = await evidenceGraphFromAggregate(root, config, workflow);
  if (graph.untrusted) return { witnesses: [], findings: graph.findings.filter(f => f.blocking !== false)
    .map(f => ({ ...f, category: 'integrity' })) };
  const evaluation = evaluateEvidence(graph);
  const owned = plannedClaimsForObservedPhase(workflow, phase.id, graph.records.planned ?? []);
  const contracts = mergedVerificationContracts(graph.records.planned ?? []);
  const witnesses = [];
  for (const [clauseId, claim] of Object.entries(owned)) {
    const row = evaluation.rows.find(row => row.id === clauseId);
    const contract = contracts.get(clauseId);
    if (!contract || !row || row.type !== 'AC') continue;
    // A primary 'any' contract already fulfilled by another slot needs no extra witness.
    const slots = row.verification?.contract?.slots ?? [];
    if (contract.combination === 'any' && slots.some(slot => slot.role === 'primary' && slot.status === 'met')) continue;
    for (const slot of contract.slots.filter(slot => slot.role === 'primary' && ['visual', 'inspection'].includes(slot.method))) {
      const status = slots.find(result => result.slot === slot.slot)?.status ?? 'pending';
      const files = slot.method === 'inspection' ? [slot.witness.path]
        : (claim.obligations ?? [claim]).filter(entry => entry.fulfillment === 'evidence').flatMap(entry => entry.expectedPaths ?? []);
      const unique = [...new Set(files)];
      const shell = safeCommandGuidance({ executable: 'singularity-flow', argv: ['decision', 'witness',
        '--work-id', workflow.workItem.id, '--criterion', clauseId, '--slot', slot.slot,
        '--file', unique.length === 1 ? unique[0] : '<EVIDENCE-PATH>', '--reason', '<review-reason>',
        ...WITNESS_CHECKLIST.flatMap(item => ['--confirm', item]), '--json'] });
      // /sf-decide handles workflow decisions, not this exact witness operation. Do not
      // route the reviewer into that unrelated menu or let an agent pre-answer a checklist.
      const command = { ...shell, skill: null, copilotCommand: null, copilotStatus: 'unavailable',
        copilotReason: 'Use the human witness terminal or VS Code witness review. /sf-decide does not implement decision witness.' };
      witnesses.push({ clauseId, slot: slot.slot, method: slot.method, status, files: unique,
        checklist: WITNESS_CHECKLIST, commandGuidance: command, humanRequired: true,
        availableAfterPublication: true, availableAfterSubmission: true, contractClassificationIsWitness: false,
        detail: 'After submission pins fresh candidate/test evidence, an authorized human must inspect the published candidate and exact file before confirming every checklist item. No agent may answer this checklist.' });
    }
  }
  return { witnesses, findings: [] };
}

export async function inspectPhaseJourney(root, config, workflow, phase, { modelEnabled = false } = {}) {
  const session = await loadSession(root, { required: false });
  const drafting = requiresProspectivePhaseInspection(workflow, phase);
  const inspection = phase.status === 'awaiting_approval'
    ? await phaseDraftCheck(root, config, workflow, phase, { session, modelEnabled })
    : await phasePrepublish(root, config, workflow, phase, { session, modelEnabled });
  const recovery = await recoveryPlan(root, config, workflow, { phaseId: phase.id, inspectActivePhase: true, modelEnabled });
  const transition = drafting ? 'publish' : phase.status === 'awaiting_approval' ? 'approve' : 'submit';
  const quality = await inspectPhaseQualityGate(root, config, workflow, phase,
    { transition: phase.status === 'awaiting_approval' ? 'approve' : 'submit' });
  const artifactQuality = await artifactQualityStatus(root, config, workflow, phase,
    await inspectPhaseAuthoredReviewContent(root, config, workflow, phase, { resolveRisks: false }), { transition });
  const witness = await phaseWitnessObligations(root, config, workflow, phase);
  const seen = new Set();
  const unique = [...quality.findings, ...inspection.findings, ...recovery.blockers, ...witness.findings].filter(f => {
    const key = `${f.details?.sourceCode ?? f.code}:${f.path ?? ''}:${f.details?.clauseId ?? f.value ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  let appeals;
  try { appeals = await phaseAppealStatus(root, config, workflow, phase); await assertPhaseAppealsResolved(root, config, workflow, phase); }
  catch (error) { unique.push({ code: error.code, category: 'appeal', path: null, message: error.message }); }
  const submission = drafting ? null : inspection.submissionReadiness ?? await submissionReadiness(root, config, workflow, { phaseId: phase.id });
  const journey = phaseJourney(workflow, phase, { findings: unique, inspection, witnesses: witness.witnesses, submission });
  return { status: unique.length ? 'resolution-required' : 'ready-for-next-check', workId: workflow.workItem.id, phaseId: phase.id,
    journey, resolution: journey.resolution, inspection, recovery, appeals, quality, artifactQuality, submission,
    repairLoop: inspection.repairLoop ?? await phaseRepairLoopSummary(root, workflow, phase),
    mutates: false, modelInvocations: 0, testsRun: false, phaseAdvanced: false };
}
