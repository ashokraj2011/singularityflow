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
import { phaseWitnessObligations } from './owed-decisions.mjs';

export { phaseWitnessObligations };

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
