import { convergenceTransitionRoute } from './phase-transition-routes.mjs';
import { phaseNeedsGeneration, sequenceGateMode } from './sequence.mjs';
import { generationSkillForPhase } from './code-delivery-policy.mjs';
import { directCopilotSkill, copilotSkillForCommand } from './copilot-guidance.mjs';
import { phaseAuthoredReviewArtifacts } from './publication-preflight.mjs';
import { changedFiles } from './git.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';
import { readSourceReviewStatus } from './source-review-lifecycle.mjs';
import { decisionFedBy, decisionSubmitArguments, recordedDecisionValues, storyDecisionView } from './workflow-decisions.mjs';
import { storyRequiresStepActions } from './step-actions.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';

function currentPublication(phase) {
  const generation = Number(phase?.generation ?? 0);
  if (!Number.isInteger(generation) || generation < 1) return null;
  const matches = (phase.generationPublications ?? []).filter((entry) =>
    Number(entry?.generation) === generation);
  return matches.length === 1 ? matches[0] : null;
}

function normalizedRepositoryPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
      || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function publicationIsRecorded(publication) {
  return Boolean(
    publication
    && normalizedRepositoryPath(publication.record?.path)
    && /^sha256:[a-f0-9]{64}$/u.test(publication.record?.sha256 ?? '')
  );
}

function submitCommand(workflow, phase) {
  return `singularity-flow submit ${phase.id} --work-id ${workflow.workItem.id}${decisionInputsNeeded(workflow, phase).length ? decisionSubmitArguments(workflow, phase.id) : ''}`;
}

/**
 * The values a host must ask for before submitting: the decision after the phase reads them, and
 * none were recorded this round. The command carries a placeholder per value for shells and
 * Copilot; a host replaces them with what the person chose.
 */
function decisionInputsNeeded(workflow, phase) {
  const decision = decisionFedBy(workflow, phase.id);
  if (!decision || recordedDecisionValues(phase, decision)) return [];
  return decision.inputs.map((input) => ({ ...input, decision: decision.id, decisionLabel: decision.label }));
}

function result(workflow, phase, overrides) {
  const publication = currentPublication(phase);
  const recorded = publicationIsRecorded(publication);
  const projected = {
    schemaVersion: 1,
    resultType: 'sflow-submission-readiness',
    workId: workflow?.workItem?.id ?? null,
    classification: 'not-applicable',
    lifecycleReady: false,
    phaseId: phase?.id ?? null,
    phaseStatus: phase?.status ?? null,
    currentGeneration: Number.isInteger(Number(phase?.generation))
      ? Number(phase.generation) : null,
    publishedGeneration: recorded ? Number(publication.generation) : null,
    draftExists: Boolean(phase?.authoringBaseline || recorded),
    draftModified: false,
    publicationRecorded: recorded,
    pendingSynchronization: false,
    confirmationRequired: false,
    sequenceGate: null,
    validation: 'deferred-to-submit',
    command: null,
    reasonCode: 'SUBMISSION_NOT_APPLICABLE',
    ...overrides
  };
  // `command` predates the explicit readiness contract and remains an alias while hosts migrate.
  // Derive the new route fields in one place so a refusal cannot point the terminal and Copilot at
  // different lifecycle operations.
  projected.nextCommand = Object.hasOwn(overrides, 'nextCommand')
    ? overrides.nextCommand
    : projected.command;
  projected.nextSkill = Object.hasOwn(overrides, 'nextSkill')
    ? overrides.nextSkill
    : projected.nextCommand
      ? copilotSkillForCommand(projected.nextCommand)
      : null;
  return projected;
}

/**
 * Read the current phase's primary review artifact through the same repository-path boundary used
 * by publication. `draftModified` means that the current authored bytes differ from the template
 * captured when generation one was prepared; managed metadata and input blocks do not count.
 */
async function submissionDraftEvidence(root, config, workflow, phaseId, changedPaths = null) {
  const phase = phaseId ? workflow?.phases?.[phaseId] ?? null : null;
  if (!phase?.requiredArtifact?.path) return { draftExists: false, draftModified: false };
  const review = await phaseAuthoredReviewArtifacts(root, config, workflow, phase);
  const primary = review.artifacts.find((artifact) => artifact.scope === 'primary') ?? null;
  const baseline = phase.authoringBaseline;
  const changed = !baseline && primary?.exists
    ? (changedPaths ?? changedFiles(root)).includes(primary.path)
    : false;
  return {
    draftExists: Boolean(primary?.exists),
    draftModified: Boolean(
      primary?.exists
      && (changed || (
        baseline?.path === phase.requiredArtifact.path
        && baseline?.fingerprint
        && primary.fingerprint !== baseline.fingerprint
      ))
    )
  };
}

/**
 * Build the host-facing readiness contract from verified lifecycle and filesystem evidence.
 * This is the shared entry point for CLI and editor surfaces; it never mutates Story state.
 */
export async function submissionReadiness(root, config, workflow, {
  phaseId = workflow?.currentPhase ?? null,
  pendingSynchronization = false,
  changedPaths = null
} = {}) {
  const draftEvidence = await submissionDraftEvidence(root, config, workflow, phaseId, changedPaths);
  let sourceReviewEvidence = null;
  const phase = phaseId ? workflow?.phases?.[phaseId] : null;
  if (phase && sourceReviewRequired(workflow, phaseId)
      && phase.status === 'in_progress' && Number(phase.generation) > 0) {
    try {
      sourceReviewEvidence = await readSourceReviewStatus(root, config, workflow, phaseId);
    } catch (error) {
      // An unavailable or malformed source is a review blocker, not a reason to lose the whole
      // host-facing readiness projection. The exact command still owns the detailed refusal.
      sourceReviewEvidence = {
        status: 'correction-required', findings: [{ code: error.code ?? 'source-review-unavailable',
          message: error.message }]
      };
    }
  }
  // Only a Story that pinned a required action reads its receipts; any other pays nothing.
  let stepActionHold = null;
  if (phase?.status === 'in_progress' && storyRequiresStepActions(workflow)) {
    try {
      const { requiredStepActionHold, stepActionHoldSentence } = await import('./step-action-receipts.mjs');
      const hold = await requiredStepActionHold(root, config, workflow);
      stepActionHold = hold ? { ...hold, reason: stepActionHoldSentence(hold) } : null;
    } catch { stepActionHold = null; }
  }
  return submissionReadinessSnapshot(workflow, {
    phaseId,
    pendingSynchronization,
    draftEvidence,
    sourceReviewEvidence,
    stepActionHold
  });
}

/**
 * Produce a small, read-only lifecycle projection for hosts that need to decide whether to invoke
 * submission. It deliberately does not predict quality-gate success: the submit command remains
 * the one authority that verifies artifacts, tests, policy and publication evidence.
 */
export function submissionReadinessSnapshot(workflow, {
  phaseId = workflow?.currentPhase ?? null,
  pendingSynchronization = false,
  draftEvidence = null,
  sourceReviewEvidence = null,
  stepActionHold = null
} = {}) {
  const phase = phaseId ? workflow?.phases?.[phaseId] ?? null : null;
  const draft = draftEvidence == null ? {} : {
    draftExists: draftEvidence.draftExists === true,
    draftModified: draftEvidence.draftModified === true
  };
  if (!phase) return result(workflow, null, {
    ...draft,
    phaseId,
    classification: 'not-applicable',
    reasonCode: phaseId ? 'PHASE_NOT_FOUND' : 'NO_ACTIVE_PHASE'
  });

  if (phaseId !== workflow.currentPhase) return result(workflow, phase, {
    ...draft,
    classification: 'phase-not-current',
    reasonCode: 'PHASE_NOT_CURRENT'
  });

  if (pendingSynchronization) return result(workflow, phase, {
    ...draft,
    classification: 'synchronization-required',
    pendingSynchronization: true,
    command: 'singularity-flow sync',
    reasonCode: 'PUBLICATION_SYNCHRONIZATION_REQUIRED'
  });

  const governanceHold = phaseGovernanceHold(workflow, phase);
  if (governanceHold) return result(workflow, phase, {
    ...draft, classification: governanceHold.classification,
    reasonCode: governanceHold.code, reason: governanceHold.reason,
    command: governanceHold.actions[0]?.command ?? null,
    nextSkill: governanceHold.actions[0]?.skill ?? null,
    actions: governanceHold.actions
  });

  // A Story waiting for a person has nothing to submit; the decision is the next action.
  if (workflow.pendingDecision) {
    const pending = storyDecisionView(workflow).pending;
    return result(workflow, phase, {
      ...draft,
      classification: 'decision-required',
      command: `singularity-flow decision show ${workflow.workItem.id}`,
      nextSkill: '/sf-decide',
      reasonCode: 'DECISION_REQUIRED',
      decision: {
        key: pending.key, decision: pending.decision, label: pending.label, reason: pending.reason,
        after: pending.after, by: pending.by, anyStep: pending.anyStep, round: pending.round, maxRounds: pending.maxRounds,
        options: pending.options.map((option) => ({
          id: option.id, label: option.label, to: option.to, toLabel: option.toLabel, reach: option.reach, skips: option.skips
        }))
      }
    });
  }

  if (phase.status === 'awaiting_approval') return result(workflow, phase, {
    ...draft,
    classification: 'already-submitted',
    command: `singularity-flow approve ${phase.id} --work-id ${workflow.workItem.id} --fetch`,
    reasonCode: 'PHASE_ALREADY_SUBMITTED'
  });

  if (phase.status !== 'in_progress') return result(workflow, phase, {
    ...draft,
    classification: 'not-applicable',
    reasonCode: 'PHASE_NOT_IN_PROGRESS'
  });

  // A required after-step action of an earlier step holds this one until its approved delivery has
  // a receipt; prepare, publish and submit refuse until then, so the hold is the next action.
  if (stepActionHold?.missing?.length) return result(workflow, phase, {
    ...draft,
    classification: 'step-action-required',
    // The Copilot route follows the command: retry and record are /sf-integrations, a pipeline's
    // receipt arrives with /sf-refresh-branch.
    command: stepActionHold.nextAction ?? `singularity-flow integrations status --work-id ${workflow.workItem.id} --all`,
    reasonCode: 'STEP_ACTION_REQUIRED_UNRECORDED',
    stepActionHold: {
      reason: stepActionHold.reason ?? null,
      runnableHere: Boolean(stepActionHold.nextAction),
      missing: stepActionHold.missing.map((entry) => ({
        key: entry.key, phaseId: entry.phaseId, generation: entry.generation, action: entry.action, target: entry.target, here: entry.here
      }))
    }
  });

  const publication = currentPublication(phase);
  const publicationRecorded = publicationIsRecorded(publication);
  const convergenceRoute = convergenceTransitionRoute(workflow, phase, { needsGeneration: phaseNeedsGeneration(workflow, phase) });
  if (convergenceRoute) return result(workflow, phase, {
    ...draft, ...convergenceRoute, nextSkill: directCopilotSkill(convergenceRoute.skill)
  });
  if (phaseNeedsGeneration(workflow, phase)) return result(workflow, phase, {
    ...draft,
    ...(sequenceGateMode(workflow, 'freshGeneration') === 'soft'
        && (publicationRecorded || sequenceGateMode(workflow, 'generationCommit') === 'soft')
      ? {
          classification: 'soft-sequence-confirmation-required',
          lifecycleReady: true,
          confirmationRequired: true,
          sequenceGate: 'freshGeneration',
          command: submitCommand(workflow, phase),
          nextSkill: '/sf-submit',
          reasonCode: 'SOFT_SEQUENCE_CONFIRMATION_REQUIRED',
          ...(decisionInputsNeeded(workflow, phase).length ? { decisionInputs: decisionInputsNeeded(workflow, phase) } : {})
        }
      : {
          classification: 'generation-required',
          command: `singularity-flow prepare ${phase.id}`,
          nextSkill: directCopilotSkill(generationSkillForPhase(phase, workflow)),
          reasonCode: 'PHASE_GENERATION_REQUIRED'
        })
  });

  if (!publicationRecorded) return result(workflow, phase, {
    ...draft,
    ...(sequenceGateMode(workflow, 'generationCommit') === 'soft'
      ? {
          classification: 'soft-sequence-confirmation-required',
          lifecycleReady: true,
          confirmationRequired: true,
          sequenceGate: 'generationCommit',
          command: submitCommand(workflow, phase),
          nextSkill: '/sf-submit',
          reasonCode: 'SOFT_SEQUENCE_CONFIRMATION_REQUIRED',
          ...(decisionInputsNeeded(workflow, phase).length ? { decisionInputs: decisionInputsNeeded(workflow, phase) } : {})
        }
      : {
          classification: Number(phase.generation ?? 0) < 1
            ? 'generation-commit-required'
            : 'publication-record-missing',
          command: 'singularity-flow doctor --json',
          reasonCode: Number(phase.generation ?? 0) < 1
            ? 'PHASE_GENERATION_COMMIT_REQUIRED'
            : 'PHASE_PUBLICATION_RECORD_MISSING'
        })
  });

  if (sourceReviewRequired(workflow, phase.id) && sourceReviewEvidence?.status !== 'ready') {
    return result(workflow, phase, {
      ...draft,
      classification: 'source-review-required',
      lifecycleReady: false,
      validation: 'source-review-pending',
      sourceReviewStatus: sourceReviewEvidence?.status ?? 'unverified',
      sourceReviewFindings: sourceReviewEvidence?.findings ?? [],
      command: `singularity-flow review-source context ${phase.id} --json`,
      nextSkill: '/sf-review-source',
      reasonCode: 'SOURCE_REVIEW_REQUIRED'
    });
  }

  const decisionInputs = decisionInputsNeeded(workflow, phase);
  return result(workflow, phase, {
    ...draft,
    classification: 'ready-to-attempt',
    lifecycleReady: true,
    command: submitCommand(workflow, phase),
    nextSkill: '/sf-submit',
    reasonCode: 'SUBMISSION_READY',
    ...(decisionInputs.length ? { decisionInputs } : {})
  });
}

export function submissionReadinessText(snapshot) {
  const state = snapshot.lifecycleReady ? 'ready' : 'not ready';
  const artifactState = !snapshot.publicationRecorded
    ? snapshot.draftExists
      ? `${snapshot.draftModified ? 'Authored draft' : 'Seeded draft'} — not published`
      : 'Draft not created — not published'
    : snapshot.classification === 'already-submitted'
      ? `Published generation ${snapshot.publishedGeneration} — submitted for approval`
      : snapshot.classification === 'synchronization-required'
        ? `Published generation ${snapshot.publishedGeneration} — synchronization required`
        : snapshot.classification === 'convergence-advance-required'
          ? `Published generation ${snapshot.publishedGeneration} — ready for governed advancement`
          : snapshot.lifecycleReady
            ? `Published generation ${snapshot.publishedGeneration} — ready to submit`
            : `Published generation ${snapshot.publishedGeneration} — not ready to submit`;
  return [
    `${snapshot.workId ?? 'Story'} · ${snapshot.phaseId ?? 'no active phase'} · ${state}`,
    `Classification: ${snapshot.classification}`,
    `Phase status: ${snapshot.phaseStatus ?? 'none'} · generation ${snapshot.currentGeneration ?? 'none'} · published ${snapshot.publishedGeneration ?? 'none'}`,
    artifactState,
    snapshot.confirmationRequired ? `Human confirmation required: soft gate ${snapshot.sequenceGate}` : null,
    snapshot.sourceReviewStatus && snapshot.sourceReviewStatus !== 'ready'
      ? `Independent source review: ${snapshot.sourceReviewStatus}` : null,
    snapshot.stepActionHold?.reason ?? null,
    `Full artifact, test, policy, and evidence validation: ${snapshot.validation}`,
    snapshot.nextCommand ? `Shell: ${snapshot.nextCommand}` : null,
    snapshot.nextSkill ? `Copilot: ${snapshot.nextSkill}` : null
  ].filter(Boolean).join('\n');
}
