/** One policy-driven continuation state. Displayed routes are never execution authority. */
import { phaseFindingPolicy } from './phase-finding-policy.mjs';
import { phaseResolutionProjection } from './phase-resolution.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { hasPublishedPhaseGeneration, requiresProspectivePhaseInspection } from './code-submission-evidence.mjs';
import { BUILD_INFO, versionLine } from './build-info.mjs';

export const PHASE_JOURNEY_CONTRACT = 1;
const guidance = argv => safeCommandGuidance({ executable: 'singularity-flow', argv });

export function phaseJourney(workflow, phase, { findings = [], inspection = {}, witnesses = [], submission = null } = {}) {
  const resolution = phaseResolutionProjection(workflow, phase, findings);
  const drafting = requiresProspectivePhaseInspection(workflow, phase);
  const integrity = findings.filter(finding => phaseFindingPolicy(finding).classification === 'integrity-or-authority');
  const producer = findings.filter(finding => phaseFindingPolicy(finding).repairableByProducer);
  const human = resolution.issues.filter(issue => issue.status === 'needs-human');
  const outstandingWitnesses = witnesses.filter(witness => witness.status !== 'met');
  const witnessOnly = findings.every(finding => (finding.details?.sourceCode ?? finding.code) === 'SPEC_COVERAGE_INCOMPLETE'
    || /^EVIDENCE_(VISUAL|INSPECTION)_/u.test(finding.code ?? ''));
  // Draft repair and pending human evidence can coexist. Do not turn a transition hold into an
  // authoring stop, or let an authoring permission imply permission to publish.
  const repairAllowed = !integrity.length && drafting && (inspection.correction?.sameTurn === true
    || inspection.draftRepair?.allowed === true);
  let state = 'owner-resolution'; let next = null;
  if (workflow.status !== 'in_progress' || phase.status === 'approved') state = 'phase-complete';
  else if (integrity.length) state = 'integrity-blocked';
  else if (repairAllowed && producer.length) state = 'draft-repair';
  else if (phase.status === 'awaiting_approval' && outstandingWitnesses.length && witnessOnly) {
    state = 'witness-review'; next = outstandingWitnesses[0].commandGuidance;
  }
  else if (human.length) state = 'human-review';
  else if (findings.length) state = producer.length ? 'draft-repair' : 'owner-resolution';
  else if (drafting && inspection.status === 'ready' && inspection.commands?.publish) {
    state = 'ready-to-publish'; next = safeCommandGuidance({ command: inspection.commands.publish });
  } else if (phase.status === 'awaiting_approval' && outstandingWitnesses.length) {
    state = 'witness-review'; next = outstandingWitnesses[0].commandGuidance;
  }
  else if (phase.status === 'awaiting_approval') {
    state = 'human-approval'; next = guidance(['approve', phase.id, '--work-id', workflow.workItem.id, '--fetch']);
  } else if (submission?.lifecycleReady === true && submission.confirmationRequired !== true
      && submission.classification === 'ready-to-attempt' && !(submission.decisionInputs?.length)) {
    // Submission pins the delivery commit/test evidence used by witnessContextBinding.
    // Asking for a witness earlier either refuses as unpublished or becomes stale on submit.
    state = 'ready-to-submit'; next = safeCommandGuidance({ command: submission.nextCommand ?? submission.command });
  } else if (submission) {
    state = 'lifecycle-review'; next = safeCommandGuidance({ command: submission.nextCommand ?? submission.command });
  }
  if (!next && !['phase-complete', 'witness-review'].includes(state)) {
    const owner = state === 'integrity-blocked'
      ? resolution.issues.find(issue => issue.policy.classification === 'integrity-or-authority')
      : state === 'draft-repair' && repairAllowed
        ? resolution.issues.find(issue => issue.policy.repairableByProducer)
        : state === 'human-review' ? human[0] : resolution.issues[0];
    next = owner?.choices?.[0]?.commandGuidance ?? guidance(['appeal', 'preflight', '--phase', phase.id, '--work-id', workflow.workItem.id, '--json']);
  }
  return { contractRevision: PHASE_JOURNEY_CONTRACT, workId: workflow.workItem.id, phaseId: phase.id,
    state, authoring: { allowed: repairAllowed, scope: repairAllowed ? 'owned-unpublished-draft' : null },
    transition: { publishAllowed: state === 'ready-to-publish', submitAllowed: state === 'ready-to-submit',
      approvalAutomatic: false, testsWaived: false },
    next, pendingHumanReviews: human, witnesses, resolution,
    build: { description: versionLine(), ...BUILD_INFO },
    preservation: { discardAutomatic: false, approvedHistoryMutable: false, checkpointAvailable: true } };
}
