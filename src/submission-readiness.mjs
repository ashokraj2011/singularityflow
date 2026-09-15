import { phaseNeedsGeneration, sequenceGateMode } from './sequence.mjs';

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
  return `singularity-flow submit ${phase.id} --work-id ${workflow.workItem.id}`;
}

function result(workflow, phase, overrides) {
  const publication = currentPublication(phase);
  const recorded = publicationIsRecorded(publication);
  return {
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
    publicationRecorded: recorded,
    pendingSynchronization: false,
    confirmationRequired: false,
    sequenceGate: null,
    validation: 'deferred-to-submit',
    command: null,
    reasonCode: 'SUBMISSION_NOT_APPLICABLE',
    ...overrides
  };
}

/**
 * Produce a small, read-only lifecycle projection for hosts that need to decide whether to invoke
 * submission. It deliberately does not predict quality-gate success: the submit command remains
 * the one authority that verifies artifacts, tests, policy and publication evidence.
 */
export function submissionReadinessSnapshot(workflow, {
  phaseId = workflow?.currentPhase ?? null,
  pendingSynchronization = false
} = {}) {
  const phase = phaseId ? workflow?.phases?.[phaseId] ?? null : null;
  if (!phase) return result(workflow, null, {
    phaseId,
    classification: 'not-applicable',
    reasonCode: phaseId ? 'PHASE_NOT_FOUND' : 'NO_ACTIVE_PHASE'
  });

  if (phaseId !== workflow.currentPhase) return result(workflow, phase, {
    classification: 'phase-not-current',
    reasonCode: 'PHASE_NOT_CURRENT'
  });

  if (pendingSynchronization) return result(workflow, phase, {
    classification: 'synchronization-required',
    pendingSynchronization: true,
    command: 'singularity-flow sync',
    reasonCode: 'PUBLICATION_SYNCHRONIZATION_REQUIRED'
  });

  if (phase.status === 'awaiting_approval') return result(workflow, phase, {
    classification: 'already-submitted',
    command: `singularity-flow approve ${phase.id} --work-id ${workflow.workItem.id} --fetch`,
    reasonCode: 'PHASE_ALREADY_SUBMITTED'
  });

  if (phase.status !== 'in_progress') return result(workflow, phase, {
    classification: 'not-applicable',
    reasonCode: 'PHASE_NOT_IN_PROGRESS'
  });

  const publication = currentPublication(phase);
  const publicationRecorded = publicationIsRecorded(publication);
  if (phaseNeedsGeneration(workflow, phase)) return result(workflow, phase, {
    ...(sequenceGateMode(workflow, 'freshGeneration') === 'soft'
        && (publicationRecorded || sequenceGateMode(workflow, 'generationCommit') === 'soft')
      ? {
          classification: 'soft-sequence-confirmation-required',
          lifecycleReady: true,
          confirmationRequired: true,
          sequenceGate: 'freshGeneration',
          command: submitCommand(workflow, phase),
          reasonCode: 'SOFT_SEQUENCE_CONFIRMATION_REQUIRED'
        }
      : {
          classification: 'generation-required',
          command: `singularity-flow prepare ${phase.id}`,
          reasonCode: 'PHASE_GENERATION_REQUIRED'
        })
  });

  if (!publicationRecorded) return result(workflow, phase, {
    ...(sequenceGateMode(workflow, 'generationCommit') === 'soft'
      ? {
          classification: 'soft-sequence-confirmation-required',
          lifecycleReady: true,
          confirmationRequired: true,
          sequenceGate: 'generationCommit',
          command: submitCommand(workflow, phase),
          reasonCode: 'SOFT_SEQUENCE_CONFIRMATION_REQUIRED'
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

  if (phase.id === 'convergence') return result(workflow, phase, {
    classification: 'convergence-advance-required',
    lifecycleReady: true,
    command: `singularity-flow story advance --work-id ${workflow.workItem.id}`,
    reasonCode: 'CONVERGENCE_ADVANCE_REQUIRED'
  });

  return result(workflow, phase, {
    classification: 'ready-to-attempt',
    lifecycleReady: true,
    command: submitCommand(workflow, phase),
    reasonCode: 'SUBMISSION_READY'
  });
}

export function submissionReadinessText(snapshot) {
  const state = snapshot.lifecycleReady ? 'ready' : 'not ready';
  return [
    `${snapshot.workId ?? 'Story'} · ${snapshot.phaseId ?? 'no active phase'} · ${state}`,
    `Classification: ${snapshot.classification}`,
    `Phase status: ${snapshot.phaseStatus ?? 'none'} · generation ${snapshot.currentGeneration ?? 'none'} · published ${snapshot.publishedGeneration ?? 'none'}`,
    snapshot.confirmationRequired ? `Human confirmation required: soft gate ${snapshot.sequenceGate}` : null,
    `Full artifact, test, policy, and evidence validation: ${snapshot.validation}`,
    snapshot.command ? `Next: ${snapshot.command}` : null
  ].filter(Boolean).join('\n');
}
