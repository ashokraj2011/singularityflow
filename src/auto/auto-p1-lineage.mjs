/** Phase-run, attempt, refusal, and economics lineage for the existing Auto executor. */
import { setTimeout as delay } from 'node:timers/promises';

import {
  mutateAutoFlightState, readAutoFlightState
} from './auto-flight-store.mjs';
import {
  listAutoP1Records, persistAutoAttempt, persistAutoPhaseRun, persistAutoRefusal,
  persistAutoTokenEconomicsReceipt, readAutoP1Record, updateAutoAttempt, updateAutoPhaseRun,
  updateAutoTokenEconomicsReceipt
} from './auto-p1-records.mjs';
import { createAutoHumanBoundary } from './auto-p1-control.mjs';
import { readAutoCandidateVerification } from './auto-candidate.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';

function generationIntentSha256(phase) {
  const value = String(phase?.generationIntent?.receiptSha256 ?? '');
  const normalized = /^[a-f0-9]{64}$/u.test(value) ? `sha256:${value}` : value;
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new SingularityFlowError(
      `Phase '${phase?.id ?? 'unknown'}' has no exact generation-intent receipt for Auto lineage.`, {
        code: 'AUTO_GENERATION_INTENT_UNBOUND'
      }
    );
  }
  return normalized;
}

function invocationEconomics(invocation) {
  const usage = invocation?.usage ?? {};
  const economics = invocation?.economics ?? {};
  const input = economics.input ?? economics.provider ?? {};
  const output = economics.output ?? economics.provider ?? {};
  const number = (...values) => values.find((value) => Number.isFinite(value) && value >= 0) ?? null;
  return {
    input: {
      promptBytes: number(economics.prompt?.finalPromptBytes, invocation?.promptBytes),
      estimatedTokens: number(input.estimatedTokens),
      providerTokens: number(input.inputTokens, usage.inputTokens, usage.input_tokens),
      cachedTokens: number(input.cachedInputTokens, usage.cachedInputTokens)
    },
    output: {
      estimatedTokens: number(output.estimatedTokens),
      providerTokens: number(output.outputTokens, usage.outputTokens, usage.output_tokens)
    },
    cost: {
      amount: number(economics.provider?.providerCost, usage.providerCost),
      currency: 'USD',
      assurance: number(economics.provider?.providerCost, usage.providerCost) == null
        ? 'unavailable' : 'provider-reported'
    }
  };
}

async function finalizeAttemptEconomics(root, flightId, attempt, verification) {
  if (!attempt) return null;
  const receipt = await readAutoP1Record(
    root, 'auto-token-economics-receipt', flightId, attempt.attemptId
  ).catch((error) => {
    // Refusals can occur before a model invocation is authored. That path has no observed token
    // economics to finalize and must not fabricate a zero-valued receipt.
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!receipt) return null;
  const repairAttempts = attempt.attemptKind === 'repair' ? 1 : 0;
  const firstPass = repairAttempts === 0;
  const quality = {
    ...receipt.quality,
    verification,
    firstPass,
    repairAttempts
  };
  const classification = verification === 'failed'
    ? 'verification-failed'
    : repairAttempts === 1 ? 'verified-after-one-repair' : 'verified-first-pass';
  return updateAutoTokenEconomicsReceipt(
    root, flightId, attempt.attemptId,
    { quality, classification },
    { expectedReceiptSha256: receipt.receiptSha256 }
  );
}

async function refusalVerificationOutcome(root, state, attempt, verificationReceiptSha256) {
  if (!attempt || !verificationReceiptSha256) return 'failed';
  if (state.candidate?.candidateId && state.candidate?.attemptId === attempt.attemptId) {
    const receipt = await readAutoCandidateVerification(state.worktree, {
      flightId: state.flightId,
      candidateId: state.candidate.candidateId,
      verificationReceiptSha256
    });
    return receipt.status === 'passed' ? 'passed' : 'failed';
  }
  // A published attempt can only acquire this field after the exact Candidate verification has
  // passed. Retain that observed quality if a later publication/submission operation refuses.
  return attempt.verificationReceiptSha256 === verificationReceiptSha256 ? 'passed' : 'failed';
}

async function withAutoP1ControlLock(root, flightId, operation) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await withSubjectLock(root, {
        kind: 'auto-p1-control', id: flightId
      }, operation);
    } catch (error) {
      if (error?.code !== 'SUBJECT_LOCK_BUSY' || attempt === 199) throw error;
      await delay(5);
    }
  }
  throw new Error('unreachable');
}

async function updateAttemptRecord(root, flightId, attemptId, update) {
  const current = await readAutoP1Record(root, 'auto-attempt', flightId, attemptId);
  return updateAutoAttempt(root, flightId, attemptId, update, {
    expectedRecordSha256: current.recordSha256
  });
}

async function updatePhaseRunRecord(root, flightId, phaseRunId, update) {
  const current = await readAutoP1Record(root, 'auto-phase-run', flightId, phaseRunId);
  return updateAutoPhaseRun(root, flightId, phaseRunId, update, {
    expectedRecordSha256: current.recordSha256
  });
}

async function beginAutoAttemptLineageLocked(root, flightId, {
  phase, phaseContract
}) {
  const intentSha256 = generationIntentSha256(phase);
  let state = await readAutoFlightState(root, flightId);
  if (state.activeAttemptId) {
    let current = await readAutoP1Record(root, 'auto-attempt', flightId, state.activeAttemptId)
      .catch(() => null);
    if (current && ['planned', 'running'].includes(current.status)) {
      const repairAuthorizationReason = state.activeRepairPlanId
        ? `repair-authorization:${state.activeRepairPlanId}` : null;
      const isRepairAuthorization = current.status === 'planned'
        && current.attemptKind === 'repair'
        && current.reason === repairAuthorizationReason
        && state.position === 'repair-authorized';
      if (isRepairAuthorization) {
        // Repair authorization happens before the lifecycle opens the next generation, so it
        // cannot truthfully carry that future intent or its composed contracts. Close the exact
        // reservation record and mint a separate execution attempt below after those authorities
        // exist. Immutable authority is never rebound, and no model budget is charged here.
        current = await updateAutoAttempt(root, flightId, current.attemptId, {
          status: 'failed',
          result: {
            status: 'failed', code: 'AUTO_REPAIR_AUTHORIZATION_CONSUMED',
            message: 'Repair authorization was consumed by an exact governed generation attempt.'
          }
        }, { expectedRecordSha256: current.recordSha256 });
        state = await mutateAutoFlightState(root, flightId, (draft) => {
          draft.activeAttemptId = null;
        }, { expectedCheckpoint: state.checkpointSha256 });
      }
    }
    if (current && ['planned', 'running'].includes(current.status)) {
      let phaseRun = state.activePhaseRunId
        ? await readAutoP1Record(root, 'auto-phase-run', flightId, state.activePhaseRunId)
        : null;
      if (!phaseRun) phaseRun = await persistAutoPhaseRun(root, {
        flightId, phase: phase.id, status: 'running', attemptIds: [current.attemptId],
        activeAttemptId: current.attemptId, publishedGenerations: [],
        requiredHumanRequestIds: [], phaseCheckpointSha256: state.checkpointSha256
      });
      const expectedAuthority = {
        phase: phase.id,
        generationIntentSha256: intentSha256,
        taskContractSha256: phaseContract.taskContractSha256,
        contextManifestSha256: phaseContract.contextContractSha256,
        executionUnitManifestSha256: phaseContract.executionUnitContractSha256
      };
      const staleAuthority = Object.entries(expectedAuthority)
        .filter(([field, expected]) => current[field] !== expected)
        .map(([field]) => field);
      if (staleAuthority.length) {
        throw new SingularityFlowError(
          `Active Auto attempt '${current.attemptId}' is bound to different immutable authority.`, {
            code: 'AUTO_ATTEMPT_AUTHORITY_STALE',
            details: { attemptId: current.attemptId, mismatchedFields: staleAuthority }
          }
        );
      }
      if (phaseRun.phase !== phase.id) {
        throw new SingularityFlowError(
          `Active Auto phase run '${phaseRun.phaseRunId}' belongs to a different phase.`, {
            code: 'AUTO_PHASE_RUN_RECONCILIATION_REQUIRED',
            details: {
              phaseRunId: phaseRun.phaseRunId,
              expectedPhase: phase.id,
              actualPhase: phaseRun.phase
            }
          }
        );
      }
      current = await updateAutoAttempt(root, flightId, current.attemptId, {
        status: 'running'
      }, { expectedRecordSha256: current.recordSha256 });
      phaseRun = await updateAutoPhaseRun(root, flightId, phaseRun.phaseRunId, {
        status: 'running', attemptIds: [...new Set([...phaseRun.attemptIds, current.attemptId])],
        activeAttemptId: current.attemptId, phaseCheckpointSha256: state.checkpointSha256
      }, { expectedRecordSha256: phaseRun.recordSha256 });
      if (state.activePhaseRunId !== phaseRun.phaseRunId) state = await mutateAutoFlightState(root, flightId, (draft) => {
        draft.activePhaseRunId = phaseRun.phaseRunId;
        draft.phaseRunIds = [...new Set([...(draft.phaseRunIds ?? []), phaseRun.phaseRunId])];
      }, { expectedCheckpoint: state.checkpointSha256 });
      return { state, phaseRun, attempt: current, reused: true };
    }
  }
  const phaseRuns = await listAutoP1Records(root, 'auto-phase-run', flightId);
  const activePhaseRuns = phaseRuns.filter((entry) => (
    entry.phase === phase.id && !['completed', 'halted'].includes(entry.status)
  ));
  if (activePhaseRuns.length > 1) {
    throw new SingularityFlowError(
      `Auto phase '${phase.id}' has multiple unclosed phase-run records.`, {
        code: 'AUTO_PHASE_RUN_RECONCILIATION_REQUIRED',
        details: { phaseRunIds: activePhaseRuns.map((entry) => entry.phaseRunId) }
      }
    );
  }
  let phaseRun = activePhaseRuns[0];
  if (!phaseRun) {
    phaseRun = await persistAutoPhaseRun(root, {
      flightId, phase: phase.id, status: 'running', attemptIds: [], activeAttemptId: null,
      publishedGenerations: [], requiredHumanRequestIds: [], phaseCheckpointSha256: state.checkpointSha256
    });
  }
  const existingAttempts = await listAutoP1Records(root, 'auto-attempt', flightId);
  const repair = state.position === 'repair-authorized';
  const phaseAttempts = existingAttempts.filter((entry) => entry.phase === phase.id);
  const executionAttempts = phaseAttempts.filter((entry) => (
    !entry.reason.startsWith('repair-authorization:')
  ));
  const settledAttempts = phaseAttempts.filter((entry) => !['planned', 'running'].includes(entry.status));
  let repairAuthorization = null;
  if (repair) {
    const activeRepairPlanSha256 = state.activeRepair?.repairPlanSha256 ?? null;
    const matches = (state.repairAttempts ?? []).filter((entry) => (
      entry.repairPlanSha256 === activeRepairPlanSha256
    ));
    if (!state.activeRepairPlanId
        || state.activeRepair?.repairPlanId !== state.activeRepairPlanId
        || !activeRepairPlanSha256
        || matches.length !== 1) {
      throw new SingularityFlowError(
        'The authorized repair cannot be bound to one exact Repair Plan lineage entry.', {
          code: 'AUTO_REPAIR_PLAN_STALE',
          details: {
            activeRepairPlanId: state.activeRepairPlanId ?? null,
            matchingAuthorizations: matches.length
          }
        }
      );
    }
    [repairAuthorization] = matches;
  }
  const parentAttemptId = repair
    ? repairAuthorization.parentAttemptId
    : settledAttempts.at(-1)?.attemptId ?? null;
  const attemptKind = repair ? 'repair' : parentAttemptId ? 'resume' : 'initial';
  const reason = repair ? `repair:${state.activeRepairPlanId}` : 'phase-entry';
  const recoverable = phaseAttempts.filter((entry) => (
    ['planned', 'running'].includes(entry.status)
      && entry.attemptKind === attemptKind
      && entry.parentAttemptId === parentAttemptId
      && entry.reason === reason
      && entry.generationIntentSha256 === intentSha256
      && entry.taskContractSha256 === phaseContract.taskContractSha256
      && entry.contextManifestSha256 === phaseContract.contextContractSha256
      && entry.executionUnitManifestSha256 === phaseContract.executionUnitContractSha256
  ));
  if (recoverable.length > 1) {
    throw new SingularityFlowError(
      `Auto phase '${phase.id}' has multiple recoverable attempt records.`, {
        code: 'AUTO_ATTEMPT_RECONCILIATION_REQUIRED',
        details: { attemptIds: recoverable.map((entry) => entry.attemptId) }
      }
    );
  }
  const unresolvedAttempts = phaseAttempts.filter((entry) => (
    ['planned', 'running'].includes(entry.status)
      && !recoverable.some((candidate) => candidate.attemptId === entry.attemptId)
  ));
  if (unresolvedAttempts.length) {
    throw new SingularityFlowError(
      `Auto phase '${phase.id}' has a live attempt bound to different immutable authority.`, {
        code: 'AUTO_ATTEMPT_AUTHORITY_STALE',
        details: { attemptIds: unresolvedAttempts.map((entry) => entry.attemptId) }
      }
    );
  }
  const attempt = recoverable[0] ?? await persistAutoAttempt(root, {
    flightId, phase: phase.id,
    attemptNumber: Math.max(0, ...executionAttempts.map((entry) => entry.attemptNumber)) + 1,
    attemptKind, parentAttemptId, reason,
    generationIntentSha256: intentSha256,
    taskContractSha256: phaseContract.taskContractSha256,
    contextManifestSha256: phaseContract.contextContractSha256,
    executionUnitManifestSha256: phaseContract.executionUnitContractSha256,
    status: 'running',
    budgetImpact: { modelInvocations: 1, repairAttempts: repair ? 1 : 0 }, result: null
  });
  phaseRun = await updateAutoPhaseRun(root, flightId, phaseRun.phaseRunId, {
    status: 'running', attemptIds: [...new Set([...phaseRun.attemptIds, attempt.attemptId])],
    activeAttemptId: attempt.attemptId, phaseCheckpointSha256: state.checkpointSha256
  }, { expectedRecordSha256: phaseRun.recordSha256 });
  state = await mutateAutoFlightState(root, flightId, (draft) => {
    draft.activePhaseRunId = phaseRun.phaseRunId;
    draft.activeAttemptId = attempt.attemptId;
    draft.phaseRunIds = [...new Set([...(draft.phaseRunIds ?? []), phaseRun.phaseRunId])];
    draft.attemptIds = [...new Set([...(draft.attemptIds ?? []), attempt.attemptId])];
    if (repair) {
      const authorization = draft.repairAttempts?.find((entry) => (
        entry.repairPlanSha256 === draft.activeRepair?.repairPlanSha256
      ));
      if (authorization) authorization.attemptId = attempt.attemptId;
    }
  }, { expectedCheckpoint: state.checkpointSha256 });
  return { state, phaseRun, attempt, reused: Boolean(recoverable[0]) };
}

export async function beginAutoAttemptLineage(root, flightId, input) {
  return withAutoP1ControlLock(
    root, flightId, () => beginAutoAttemptLineageLocked(root, flightId, input)
  );
}

export async function recordAutoAttemptAuthored(root, flightId, attemptId, {
  invocation, candidateSha256 = null, worldModelReference = null, comprehensionReference = null
}) {
  const state = await readAutoFlightState(root, flightId);
  const attempt = await updateAttemptRecord(root, flightId, attemptId, {
    status: 'authored', candidateSha256,
    result: { status: 'authored', invocationId: invocation?.invocationId ?? null }
  });
  if (state.activePhaseRunId) await updatePhaseRunRecord(root, flightId, state.activePhaseRunId, {
    status: 'verifying', activeAttemptId: attemptId
  });
  const observed = invocationEconomics(invocation);
  const receipt = await persistAutoTokenEconomicsReceipt(root, {
    flightId, attemptId, contextManifestSha256: attempt.contextManifestSha256,
    ...observed,
    quality: {
      verification: 'pending', firstPass: attempt.attemptKind !== 'repair',
      repairAttempts: attempt.attemptKind === 'repair' ? 1 : 0,
      reviewReturned: false, missingContextIncident: false
    },
    classification: attempt.attemptKind === 'repair' ? 'repair-pending-verification' : 'first-pass-pending-verification',
    worldModelReference, comprehensionReference
  });
  return { attempt, receipt };
}

export async function recordAutoAttemptRefusal(root, flightId, {
  attemptId, phase, gate, code, message, candidateSha256 = null,
  verificationReceiptSha256 = null, changedPaths = [], repairScope = []
}) {
  const state = await readAutoFlightState(root, flightId);
  const attempt = attemptId
    ? await readAutoP1Record(root, 'auto-attempt', flightId, attemptId).catch(() => null)
    : null;
  const secondFailure = attempt?.attemptKind === 'repair';
  const boundVerificationReceiptSha256 = verificationReceiptSha256
    ?? (state.candidate?.attemptId === attempt?.attemptId
      ? state.candidate?.verificationReceiptSha256 ?? null : null)
    ?? attempt?.verificationReceiptSha256 ?? null;
  const refusal = await persistAutoRefusal(root, {
    flightId, phase, attemptId: attempt?.attemptId ?? state.activeAttemptId ?? `AAT-${'0'.repeat(26)}`,
    gate, code,
    subject: { candidateSha256, verificationReceiptSha256: boundVerificationReceiptSha256 },
    missing: [{ requirement: gate, evidence: String(message ?? code) }],
    preserved: {
      candidateSha256, verificationReceiptSha256: boundVerificationReceiptSha256,
      changedPaths: changedPaths.length, paths: changedPaths, workingArea: true
    },
    repair: {
      eligibility: secondFailure ? 'ineligible' : 'ask-only',
      operation: 'auto.repair', scope: repairScope, maximumAttempts: secondFailure ? 0 : 1
    },
    primaryNextAction: secondFailure
      ? { operation: 'auto.takeover', label: 'Take over the preserved Story manually' }
      : { operation: 'auto.repair', label: 'Review one bounded Repair Plan' }
  });
  if (attempt) await updateAutoAttempt(root, flightId, attempt.attemptId, {
    status: 'refused', candidateSha256,
    verificationReceiptSha256: boundVerificationReceiptSha256,
    result: { status: 'refused', refusalId: refusal.refusalId, refusalSha256: refusal.refusalSha256 }
  }, { expectedRecordSha256: attempt.recordSha256 });
  await finalizeAttemptEconomics(
    root, flightId, attempt,
    await refusalVerificationOutcome(
      root, state, attempt, boundVerificationReceiptSha256
    )
  );
  if (state.activePhaseRunId) await updatePhaseRunRecord(root, flightId, state.activePhaseRunId, {
    status: secondFailure ? 'halted' : 'refused', activeAttemptId: attempt?.attemptId ?? state.activeAttemptId
  });
  const current = await readAutoFlightState(root, flightId);
  const flight = await mutateAutoFlightState(root, flightId, (draft) => {
    draft.activeRefusalId = refusal.refusalId;
    draft.refusalIds = [...new Set([...(draft.refusalIds ?? []), refusal.refusalId])];
    if (secondFailure) {
      draft.failureComparison = {
        originalRefusalSha256: draft.repairAttempts?.at(-1)?.refusalSha256 ?? null,
        repairRefusalSha256: refusal.refusalSha256,
        repairPlanSha256: draft.activeRepairPlanId
          ? draft.repairAttempts?.at(-1)?.repairPlanSha256 ?? null : null,
        result: 'second-failure-halt'
      };
    }
  }, { expectedCheckpoint: current.checkpointSha256 });
  return { flight, attempt, refusal, secondFailure };
}

export async function recordAutoAttemptPublished(root, flightId, attemptId, {
  generation, candidateSha256 = null, verificationReceiptSha256 = null,
  publicationReceiptSha256 = null
} = {}) {
  const state = await readAutoFlightState(root, flightId);
  const attempt = await updateAttemptRecord(root, flightId, attemptId, {
    status: 'published', candidateSha256, verificationReceiptSha256, publicationReceiptSha256,
    result: { status: 'published', generation: generation ?? null }
  });
  if (state.activePhaseRunId) {
    const phaseRun = await readAutoP1Record(root, 'auto-phase-run', flightId, state.activePhaseRunId);
    await updateAutoPhaseRun(root, flightId, state.activePhaseRunId, {
      status: 'published',
      publishedGenerations: [...phaseRun.publishedGenerations, {
        generation: generation ?? null, candidateSha256, publicationReceiptSha256
      }]
    }, { expectedRecordSha256: phaseRun.recordSha256 });
  }
  return attempt;
}

export async function recordAutoAttemptCompleted(root, flightId, attemptId, {
  verificationReceiptSha256 = null, publicationReceiptSha256 = null, candidateSha256 = null
} = {}) {
  const state = await readAutoFlightState(root, flightId);
  const attempt = await updateAttemptRecord(root, flightId, attemptId, {
    status: 'completed', candidateSha256, verificationReceiptSha256, publicationReceiptSha256,
    result: { status: 'completed' }
  });
  await finalizeAttemptEconomics(root, flightId, attempt, 'passed');
  if (state.activePhaseRunId) await updatePhaseRunRecord(root, flightId, state.activePhaseRunId, {
    status: 'completed', activeAttemptId: attemptId, phaseCheckpointSha256: state.checkpointSha256
  });
  return attempt;
}

export async function ensureAutoClarificationRequest(root, flightId, detail) {
  const state = await readAutoFlightState(root, flightId);
  const existing = await listAutoP1Records(root, 'auto-human-request', flightId);
  const open = existing.find((entry) => entry.status === 'open' && entry.requestType === 'clarification');
  if (open) return { flight: state, request: open };
  return createAutoHumanBoundary(root, flightId, {
    requestType: 'clarification', title: 'Clarification required before Auto can continue',
    detail: { question: String(detail), whyStopped: 'The answer materially changes governed intent or scope.' },
    options: []
  });
}
