/** AUT v2 review-first product operations layered over the existing Story flight. */
import { loadDefinition } from '../config.mjs';
import { recordSha256 } from '../records.mjs';
import { loadStoryAggregate } from '../state-stores.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  mutateAutoFlightState, readAutoFlightState, listAutoFlights
} from './auto-flight-store.mjs';
import {
  buildAutoAttempt, buildAutoHumanRequest, listAutoP1Records, persistAutoAttempt,
  persistAutoExecutionUnitSwitch, persistAutoHumanRequest, persistAutoRepairPlan, readAutoP1Record,
  updateAutoExecutionUnitSwitch, updateAutoHumanRequest
} from './auto-p1-records.mjs';
import { assertAutoCredentialBrokerReference } from './auto-credential-reference.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;

function digest(value) { return `sha256:${recordSha256(value)}`; }

function fail(message, code, details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

function exactHash(value, label) {
  const normalized = String(value ?? '').trim();
  if (!HASH.test(normalized)) fail(`${label} must be an exact sha256 digest.`, 'AUTO_CONFIRMATION_REQUIRED');
  return normalized;
}

function currentRefusalCandidate(refusal) {
  const subject = refusal.subject?.candidateSha256 ?? null;
  const preserved = refusal.preserved?.candidateSha256 ?? null;
  const subjectVerification = refusal.subject?.verificationReceiptSha256 ?? null;
  const preservedVerification = refusal.preserved?.verificationReceiptSha256 ?? null;
  if (subject !== preserved || subjectVerification !== preservedVerification) {
    fail('The refusal binds different subject and preserved Candidate authority.',
      'AUTO_REFUSAL_STALE', {
        subject, preserved, subjectVerification, preservedVerification
      });
  }
  return subject;
}

function assertCurrentRefusalAuthority(state, refusal, plan = null, {
  activeAttemptId = refusal.attemptId, allowRepairAuthorized = false
} = {}) {
  const expectedCandidate = currentRefusalCandidate(refusal);
  const actualCandidate = state.candidate?.candidateSha256 ?? null;
  const compatiblePositions = {
    authoring: ['story-created', 'repair-authorized'],
    'generation-publication': ['authored'],
    'verification-or-submission': ['authored', 'published']
  }[refusal.gate] ?? null;
  const incompatiblePosition = compatiblePositions && !compatiblePositions.includes(state.position)
    && !(allowRepairAuthorized && state.position === 'repair-authorized');
  const stale = state.activeRefusalId !== refusal.refusalId
    || state.activeAttemptId !== activeAttemptId
    || state.story.phase !== refusal.phase
    || actualCandidate !== expectedCandidate
    || (plan && (plan.refusalSha256 !== refusal.refusalSha256
      || plan.parentAttemptId !== refusal.attemptId))
    || incompatiblePosition;
  if (stale) {
    fail(`Refusal '${refusal.refusalId}' is no longer the exact active repair authority.`,
      plan ? 'AUTO_REPAIR_PLAN_STALE' : 'AUTO_REFUSAL_STALE', {
        activeRefusalId: state.activeRefusalId,
        activeAttemptId: state.activeAttemptId,
        currentPhase: state.story.phase,
        currentPosition: state.position,
        currentCandidateSha256: actualCandidate
      });
  }
}

function assertSwitchQuiescence(state) {
  if (!['paused', 'waiting-human', 'manual-takeover'].includes(state.status)
      || (state.stopRequested && !state.stopRequested.quiescedAt)) {
    fail('Execution Unit switching is allowed only between quiescent attempts.',
      'AUTO_SWITCH_NOT_QUIESCENT');
  }
  if ((state.openHumanRequestIds ?? []).length) {
    fail('Execution Unit switching cannot bypass an open Human Request.',
      'AUTO_HUMAN_REQUEST_REQUIRED', { requestIds: state.openHumanRequestIds });
  }
}

function localBoundaryPointer(pointer) {
  return {
    checkpointClass: pointer.checkpointClass,
    path: pointer.path,
    checkpointSha256: pointer.checkpointSha256,
    commit: pointer.commit,
    eventId: pointer.eventId,
    phase: pointer.phase,
    position: pointer.position,
    createdAt: pointer.createdAt
  };
}

async function publishControlBoundary(root, state, options = {}, bind = null) {
  const publishBoundary = options.publishBoundary ?? (async (...args) => {
    const { publishAutoBoundaryCheckpoint } = await import('./auto-checkpoint.mjs');
    return publishAutoBoundaryCheckpoint(...args);
  });
  let pointer;
  try {
    pointer = await publishBoundary(
      state.worktree, state, 'human-boundary', { operationalRoot: root }
    );
  } catch (error) {
    const recovery = await mutateAutoFlightState(root, state.flightId, (draft) => {
      draft.status = 'recovery-required';
      draft.stopReason = 'human-boundary-checkpoint-publication-failed';
      draft.nextAction = 'Repair or synchronize Story publication, then recover the exact Human Request or execution-unit decision.';
      draft.lastError = {
        code: error.code ?? 'AUTO_CHECKPOINT_PUBLICATION_FAILED',
        message: error.message
      };
    }, { expectedCheckpoint: state.checkpointSha256 });
    throw new SingularityFlowError(
      `Auto flight '${state.flightId}' recorded the decision locally but could not publish its governed Human Boundary checkpoint.`, {
        code: 'AUTO_CHECKPOINT_PUBLICATION_FAILED', cause: error,
        details: {
          flightId: state.flightId, status: recovery.status,
          checkpointSha256: recovery.checkpointSha256
        }
      }
    );
  }
  return mutateAutoFlightState(root, state.flightId, (draft) => {
    const localPointer = localBoundaryPointer(pointer);
    draft.boundaryCheckpoints = [...(draft.boundaryCheckpoints ?? []), localPointer];
    draft.boundaryCheckpoint = localPointer;
    draft.lastSuccessfulStoryRevision = pointer.commit;
    draft.commits = { ...(draft.commits ?? {}), humanBoundaryCheckpoint: pointer.commit };
    bind?.(draft, localPointer);
  }, { expectedCheckpoint: state.checkpointSha256 });
}

async function records(root, family, flightId) {
  return listAutoP1Records(root, family, flightId).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
}

async function loadPinnedStoryAuthority(state) {
  const definition = await loadDefinition(state.worktree);
  const workflow = await loadStoryAggregate(state.worktree, definition, state.story.workId);
  const expectedConfig = state.configuration?.storyConfigSha256 ?? null;
  const actualConfig = workflow.resolution?.configSha256 ?? null;
  if (expectedConfig && actualConfig !== expectedConfig) {
    fail('The managed Story no longer resolves the configuration pinned by its Auto Plan.',
      'AUTO_PLAN_STALE', { expectedConfig, actualConfig });
  }
  if (workflow.currentPhase !== state.story.phase) {
    fail('The managed Story phase changed outside the reviewed Auto control transition.',
      'AUTO_FLIGHT_STALE', {
        expectedPhase: state.story.phase, actualPhase: workflow.currentPhase
      });
  }
  return { definition, workflow, phase: workflow.phases[workflow.currentPhase] };
}

export async function autoFlightProductProjection(root, flightId) {
  const flight = await readAutoFlightState(root, flightId);
  const [phaseRuns, attempts, refusals, repairPlans, humanRequests, economics, switches] = await Promise.all([
    records(root, 'auto-phase-run', flightId),
    records(root, 'auto-attempt', flightId),
    records(root, 'auto-refusal', flightId),
    records(root, 'auto-repair-plan', flightId),
    records(root, 'auto-human-request', flightId),
    records(root, 'auto-token-economics-receipt', flightId),
    records(root, 'auto-execution-unit-switch', flightId)
  ]);
  return {
    flight, phaseRuns, attempts, refusals, repairPlans, humanRequests, economics, switches,
    current: {
      phaseRun: phaseRuns.find((entry) => entry.phaseRunId === flight.activePhaseRunId) ?? phaseRuns.at(-1) ?? null,
      attempt: attempts.find((entry) => entry.attemptId === flight.activeAttemptId) ?? attempts.at(-1) ?? null,
      refusal: refusals.find((entry) => entry.refusalId === flight.activeRefusalId) ?? refusals.at(-1) ?? null,
      humanRequest: humanRequests.find((entry) => entry.status === 'open') ?? null,
      repairPlan: repairPlans.find((entry) => entry.repairPlanId === flight.activeRepairPlanId) ?? repairPlans.at(-1) ?? null
    },
    references: {
      worldModel: flight.worldModelReference ?? null,
      comprehension: flight.comprehensionReference ?? null,
      candidate: flight.candidate?.candidateSha256 ?? null,
      report: flight.finalReportSha256 ?? null
    }
  };
}

export async function findAutoFlightForStory(root, workId) {
  const normalized = String(workId ?? '').trim();
  const matches = (await listAutoFlights(root)).filter((state) => state.story?.workId === normalized);
  if (!matches.length) fail(
    `Story '${normalized}' has no Auto flight to continue.`, 'AUTO_STORY_FLIGHT_NOT_FOUND',
    { workId: normalized, nextAction: `Create an exact continuation Plan for Story '${normalized}'.` }
  );
  if (matches.length > 1) fail(
    `Story '${normalized}' has more than one Auto flight; select an exact flight ID.`,
    'AUTO_STORY_FLIGHT_AMBIGUOUS', { workId: normalized, flights: matches.map((entry) => entry.flightId) }
  );
  return matches[0];
}

export async function planAutoRepair(root, flightId, refusalId) {
  const state = await readAutoFlightState(root, flightId);
  const refusal = await readAutoP1Record(root, 'auto-refusal', flightId, refusalId);
  if (!['auto-eligible', 'ask-only'].includes(refusal.repair.eligibility)
      || refusal.repair.maximumAttempts !== 1) {
    fail(`Refusal '${refusalId}' requires human repair.`, 'AUTO_REPAIR_NOT_ELIGIBLE', {
      refusalId, eligibility: refusal.repair.eligibility
    });
  }
  if (!['halted', 'waiting-human', 'paused'].includes(state.status)) {
    fail(`Auto flight '${flightId}' is ${state.status}; a repair cannot be planned.`,
      'AUTO_REPAIR_NOT_READY');
  }
  assertCurrentRefusalAuthority(state, refusal);
  const prior = (await records(root, 'auto-repair-plan', flightId))
    .find((entry) => entry.refusalSha256 === refusal.refusalSha256);
  if (prior) return { flight: state, refusal, repairPlan: prior, reused: true };
  const missing = refusal.missing.map((entry) => entry.evidence ?? entry.requirement ?? entry.message)
    .filter(Boolean);
  const repairPlan = await persistAutoRepairPlan(root, {
    flightId, parentAttemptId: refusal.attemptId, refusalSha256: refusal.refusalSha256,
    objective: missing.length ? `Resolve: ${missing.join('; ')}` : `Resolve ${refusal.code} at ${refusal.gate}.`,
    readScope: [...new Set([...(state.scopePrediction ?? []), ...(refusal.repair.scope ?? [])])],
    writeScope: refusal.repair.scope ?? [],
    forbiddenChanges: ['protected governance paths', 'scope outside this exact Repair Plan', 'new external effects'],
    requiredEvidence: missing.length ? missing : [`${refusal.gate} returns a passing deterministic verdict`],
    budget: {
      maximumAttempts: 1,
      remainingModelInvocations: Math.max(0,
        Number(state.execution?.ceilings?.maximumModelInvocations ?? 0)
          - Number(state.counters?.modelInvocations ?? 0))
    }, attemptNumber: 1
  });
  return { flight: state, refusal, repairPlan, reused: false };
}

export async function authorizeAutoRepair(root, flightId, repairPlanId, confirmation, options = {}) {
  const plan = await readAutoP1Record(root, 'auto-repair-plan', flightId, repairPlanId);
  if (exactHash(confirmation, 'Repair confirmation') !== plan.repairPlanSha256) {
    fail(`Repair confirmation must equal ${plan.repairPlanSha256}.`, 'AUTO_REPAIR_CONFIRMATION_REQUIRED', {
      expected: plan.repairPlanSha256
    });
  }
  const state = await readAutoFlightState(root, flightId);
  if (state.repairAttempts?.some((entry) => entry.refusalSha256 === plan.refusalSha256)) {
    const used = state.repairAttempts.find((entry) => entry.refusalSha256 === plan.refusalSha256);
    if (used.repairPlanSha256 !== plan.repairPlanSha256
        || used.parentAttemptId !== plan.parentAttemptId) {
      fail('The recorded repair attempt is not bound to the exact active Repair Plan.',
        'AUTO_REPAIR_PLAN_STALE', {
          repairPlanId: plan.repairPlanId,
          recordedRepairPlanSha256: used.repairPlanSha256,
          expectedRepairPlanSha256: plan.repairPlanSha256,
          recordedParentAttemptId: used.parentAttemptId,
          expectedParentAttemptId: plan.parentAttemptId
        });
    }
    if (state.activeRepairPlanId === plan.repairPlanId && state.position === 'repair-authorized'
        && state.status === 'running') {
      if (!state.activeRefusalId) {
        fail('The replayed Repair Plan no longer has an active refusal authority.',
          'AUTO_REPAIR_PLAN_STALE', { repairPlanId: plan.repairPlanId });
      }
      const activeRefusal = await readAutoP1Record(
        root, 'auto-refusal', flightId, state.activeRefusalId
      );
      assertCurrentRefusalAuthority(state, activeRefusal, plan, {
        activeAttemptId: used.attemptId, allowRepairAuthorized: true
      });
      const attempt = await readAutoP1Record(root, 'auto-attempt', flightId, used.attemptId);
      if (attempt.attemptKind !== 'repair'
          || attempt.parentAttemptId !== plan.parentAttemptId
          || attempt.reason !== `repair-authorization:${plan.repairPlanId}`) {
        fail('The replayed repair reservation is bound to different immutable authority.',
          'AUTO_REPAIR_PLAN_STALE', {
            repairPlanId: plan.repairPlanId, attemptId: attempt.attemptId
          });
      }
      if (used.checkpointSha256) {
        return { flight: state, repairPlan: plan, attempt, replayed: true };
      }
      const checkpointed = await publishControlBoundary(root, state, options, (draft, pointer) => {
        const entry = draft.repairAttempts.find((item) => item.refusalSha256 === plan.refusalSha256);
        if (entry) {
          entry.checkpointSha256 = pointer.checkpointSha256;
          entry.checkpointCommit = pointer.commit;
        }
      });
      return { flight: checkpointed, repairPlan: plan, attempt, replayed: true };
    }
    fail('The exact refusal has already consumed its one automatic repair attempt.', 'AUTO_REPAIR_ALREADY_USED', {
      refusalSha256: plan.refusalSha256, attemptId: used.attemptId
    });
  }
  if (!['halted', 'waiting-human', 'paused'].includes(state.status)) {
    fail(`Auto flight '${flightId}' is ${state.status}; a repair cannot start.`, 'AUTO_REPAIR_NOT_READY');
  }
  if (!state.activeRefusalId) {
    fail('The Repair Plan no longer has an active refusal authority.', 'AUTO_REPAIR_PLAN_STALE', {
      repairPlanId: plan.repairPlanId
    });
  }
  const activeRefusal = await readAutoP1Record(
    root, 'auto-refusal', flightId, state.activeRefusalId
  );
  assertCurrentRefusalAuthority(state, activeRefusal, plan);
  if (state.activeRepairPlanId && state.activeRepairPlanId !== plan.repairPlanId) {
    fail('A different Repair Plan is already active for this flight.', 'AUTO_REPAIR_PLAN_STALE', {
      activeRepairPlanId: state.activeRepairPlanId, repairPlanId: plan.repairPlanId
    });
  }
  if (state.execution?.repair?.policy === 'never'
      || Number(state.execution?.repair?.maximumAttempts ?? 1) < 1) {
    fail('The ratified Auto Plan does not permit an automatic repair attempt.', 'AUTO_REPAIR_NOT_ELIGIBLE');
  }
  const attemptsAlreadyUsed = Number(state.counters?.authoringAttempts?.[state.story.phase] ?? 0);
  if (attemptsAlreadyUsed >= Number(state.execution?.ceilings?.maximumAuthoringAttemptsPerPhase ?? 1)) {
    fail('The ratified phase attempt ceiling leaves no repair attempt.', 'AUTO_REPAIR_BUDGET_EXHAUSTED', {
      consumed: attemptsAlreadyUsed,
      maximum: state.execution?.ceilings?.maximumAuthoringAttemptsPerPhase ?? 1
    });
  }
  const authority = options.loadStoryAuthority
    ? await options.loadStoryAuthority(state) : await loadPinnedStoryAuthority(state);
  const generationIntentSha256 = authority.phase?.generationIntent?.receiptSha256 ?? null;
  if (!generationIntentSha256) {
    fail('The bounded repair cannot bind an exact governed generation intent.',
      'AUTO_GENERATION_INTENT_REQUIRED', {
        phase: state.story.phase,
        nextAction: `Open a governed generation for phase '${state.story.phase}', then review the repair again.`
      });
  }
  const attemptNumber = Number(state.counters?.authoringAttempts?.[state.story.phase] ?? 0) + 1;
  const attempt = buildAutoAttempt({
    flightId, phase: state.story.phase, attemptNumber, attemptKind: 'repair',
    // This record is the human-authorized reservation, not the model attempt. The executor must
    // first open the next governed generation and build its exact contracts; only then can it mint
    // the immutable repair attempt that consumes model budget. Keeping the identities distinct
    // avoids either rebinding this record or pretending the prior generation authorized new bytes.
    parentAttemptId: plan.parentAttemptId, reason: `repair-authorization:${plan.repairPlanId}`,
    generationIntentSha256,
    taskContractSha256: digest({ objective: plan.objective, readScope: plan.readScope, writeScope: plan.writeScope }),
    contextManifestSha256: digest({ checkpointSha256: state.checkpointSha256, refusalSha256: plan.refusalSha256 }),
    executionUnitManifestSha256: state.executionUnit?.manifestSha256
      ?? state.configuration?.executionHostDescriptorSha256
      ?? digest({ provider: state.executionUnit?.id ?? 'pinned-plan-provider' }),
    status: 'planned',
    budgetImpact: { modelInvocations: 0, repairAttempts: 0, maximumRepairAttempts: 1 },
    result: null
  });
  await persistAutoAttempt(root, attempt);
  let resumed = await mutateAutoFlightState(root, flightId, (draft) => {
    draft.status = 'running';
    draft.position = 'repair-authorized';
    draft.stopReason = 'bounded-repair-authorized';
    draft.stopRequested = null;
    draft.activeAttemptId = attempt.attemptId;
    draft.activeRepairPlanId = plan.repairPlanId;
    draft.activeRepair = {
      repairPlanId: plan.repairPlanId, repairPlanSha256: plan.repairPlanSha256,
      objective: plan.objective, readScope: plan.readScope, writeScope: plan.writeScope,
      forbiddenChanges: plan.forbiddenChanges, requiredEvidence: plan.requiredEvidence
    };
    draft.repairAttempts = [...(draft.repairAttempts ?? []), {
      attemptId: attempt.attemptId, parentAttemptId: plan.parentAttemptId,
      refusalSha256: plan.refusalSha256, repairPlanSha256: plan.repairPlanSha256,
      status: 'authorized'
    }];
    draft.nextAction = 'Run the one exact bounded repair attempt; any further failure halts.';
  }, { expectedCheckpoint: state.checkpointSha256 });
  resumed = await publishControlBoundary(root, resumed, options, (draft, pointer) => {
    const entry = draft.repairAttempts.find((item) => item.refusalSha256 === plan.refusalSha256);
    if (entry) {
      entry.checkpointSha256 = pointer.checkpointSha256;
      entry.checkpointCommit = pointer.commit;
    }
  });
  return { flight: resumed, repairPlan: plan, attempt };
}

function humanRequestIntent(request) {
  return {
    flightId: request.flightId, phase: request.phase, attemptId: request.attemptId,
    requestType: request.requestType, title: request.title, detail: request.detail,
    options: request.options, subjectSha256: request.subjectSha256,
    policySha256: request.policySha256, expiresAt: request.expiresAt
  };
}

export async function createAutoHumanBoundary(root, flightId, value, options = {}) {
  const mutateFlightState = options.mutateFlightState ?? mutateAutoFlightState;
  // A process can stop after the immutable request is written and before the flight CAS. On every
  // retry, rediscover that exact request by its closed semantic authority and attach it instead of
  // overwriting it or minting a second request. A live CAS race is retried through the same path.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readAutoFlightState(root, flightId);
    const subjectSha256 = value.subjectSha256 ?? digest({
      story: state.story, phase: state.story.phase, evidence: state.evidence ?? {},
      candidateSha256: state.candidate?.candidateSha256 ?? null
    });
    const policySha256 = value.policySha256 ?? digest({
      planSha256: state.planSha256, configuration: state.configuration ?? null,
      execution: state.execution ?? null
    });
    const proposed = buildAutoHumanRequest({
      flightId, phase: state.story.phase,
      attemptId: value.attemptId ?? state.activeAttemptId ?? null,
      requestType: value.requestType, title: value.title,
      detail: value.detail ?? {}, options: value.options ?? [],
      subjectSha256, policySha256, checkpointSha256: state.checkpointSha256,
      status: 'open', response: null, expiresAt: value.expiresAt ?? null
    }, options);
    const existing = (await listAutoP1Records(root, 'auto-human-request', flightId))
      .filter((request) => request.status === 'open'
        && digest(humanRequestIntent(request)) === digest(humanRequestIntent(proposed)));
    if (existing.length > 1) {
      fail('Multiple open Human Requests claim the same exact decision authority.',
        'AUTO_HUMAN_REQUEST_RECONCILIATION_REQUIRED', {
          requestIds: existing.map((request) => request.requestId)
        });
    }
    const request = existing[0]
      ?? await persistAutoHumanRequest(root, proposed, options);
    try {
      let waiting = await mutateFlightState(root, flightId, (draft) => {
        draft.status = 'waiting-human';
        draft.stopReason = `${request.requestType}-required`;
        draft.openHumanRequestIds = [...new Set([
          ...(draft.openHumanRequestIds ?? []), request.requestId
        ])];
        draft.nextAction = `Review Human Request ${request.requestId}; generic Auto continue cannot decide it.`;
      }, { expectedCheckpoint: state.checkpointSha256 });
      waiting = await publishControlBoundary(root, waiting, options);
      return { flight: waiting, request, replayed: Boolean(existing[0]) };
    } catch (error) {
      if (error?.code !== 'AUTO_CHECKPOINT_STALE' || attempt === 2) throw error;
    }
  }
  throw new Error('unreachable');
}

export async function respondAutoHumanRequest(
  root, flightId, requestId, response, confirmation, options = {}
) {
  const request = await readAutoP1Record(root, 'auto-human-request', flightId, requestId);
  const expectedConfirmation = request.status === 'answered'
    ? request.response?.requestSha256 : request.requestSha256;
  if (exactHash(confirmation, 'Human Request confirmation') !== expectedConfirmation) {
    fail(`Human Request confirmation must equal ${expectedConfirmation}.`, 'AUTO_HUMAN_REQUEST_CONFIRMATION_REQUIRED', {
      expected: expectedConfirmation
    });
  }
  if (!['open', 'answered'].includes(request.status)) fail(
    `Human Request '${requestId}' is ${request.status}.`, 'AUTO_HUMAN_REQUEST_CLOSED'
  );
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    fail('Human Request response must be a typed object.', 'AUTO_HUMAN_REQUEST_RESPONSE_INVALID');
  }
  if (request.requestType === 'credential') {
    const fields = Object.keys(response);
    if (!fields.includes('brokerReference') || fields.some((field) => !['brokerReference', 'status'].includes(field))) {
      fail('Credential responses must contain only an approved brokerReference and status.', 'AUTO_HUMAN_REQUEST_RESPONSE_INVALID');
    }
    assertAutoCredentialBrokerReference(response.brokerReference);
  } else if (request.requestType === 'architecture-choice') {
    const fields = Object.keys(response);
    const allowed = new Set((request.options ?? []).map((option) => (
      typeof option === 'string' ? option : option?.id
    )).filter(Boolean));
    if (fields.length !== 1 || fields[0] !== 'choice' || !allowed.has(response.choice)) {
      fail('Architecture responses must select one exact offered choice.', 'AUTO_HUMAN_REQUEST_RESPONSE_INVALID', {
        allowed: [...allowed]
      });
    }
  } else {
    const fields = Object.keys(response);
    if (fields.length !== 1 || !['answer', 'choice'].includes(fields[0])
        || !String(response[fields[0]] ?? '').trim()
        || String(response[fields[0]]).length > 4_096) {
      fail('Clarification responses must contain one bounded answer or offered choice.', 'AUTO_HUMAN_REQUEST_RESPONSE_INVALID');
    }
  }
  const state = await readAutoFlightState(root, flightId);
  if (request.status === 'answered') {
    const responseSha256 = digest({ requestSha256: expectedConfirmation, response });
    if (request.response?.responseSha256 !== responseSha256) {
      fail(`Human Request '${requestId}' was answered with different content.`, 'AUTO_HUMAN_REQUEST_CLOSED');
    }
    if (!(state.openHumanRequestIds ?? []).includes(requestId)) return { flight: state, request, replayed: true };
  } else if (!(state.openHumanRequestIds ?? []).includes(requestId)) {
    fail(`Human Request '${requestId}' is not current for this flight.`, 'AUTO_HUMAN_REQUEST_STALE');
  }
  if (state.status !== 'waiting-human'
      || request.phase !== state.story.phase
      || request.attemptId !== (state.activeAttemptId ?? null)) {
    fail(`Human Request '${requestId}' no longer matches the active phase and attempt.`,
      'AUTO_HUMAN_REQUEST_STALE', {
        requestPhase: request.phase, currentPhase: state.story.phase,
        requestAttemptId: request.attemptId, activeAttemptId: state.activeAttemptId
      });
  }
  if (request.status === 'open' && request.expiresAt != null) {
    const expiresAt = Date.parse(request.expiresAt);
    const now = Date.parse(String(options.now?.() ?? new Date().toISOString()));
    if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now) {
      fail(`Human Request '${requestId}' has expired.`, 'AUTO_HUMAN_REQUEST_EXPIRED', {
        expiresAt: request.expiresAt
      });
    }
  }
  const answered = request.status === 'answered' ? request : await updateAutoHumanRequest(
    root, flightId, requestId, {
      status: 'answered',
      response: {
        value: structuredClone(response),
        requestSha256: request.requestSha256,
        responseSha256: digest({ requestSha256: request.requestSha256, response })
      }
    }, { expectedRequestSha256: request.requestSha256 }
  );
  let paused = await mutateAutoFlightState(root, flightId, (draft) => {
    draft.openHumanRequestIds = (draft.openHumanRequestIds ?? []).filter((id) => id !== requestId);
    draft.humanRequestDecisions = [...(draft.humanRequestDecisions ?? []), {
      requestId, requestSha256: request.requestSha256,
      responseSha256: answered.response.responseSha256, requestType: request.requestType
    }];
    draft.status = 'paused';
    draft.stopReason = 'human-request-answered';
    draft.nextAction = 'Review the recorded answer, then resume with the new exact checkpoint hash.';
  }, { expectedCheckpoint: state.checkpointSha256 });
  paused = await publishControlBoundary(root, paused, options);
  return { flight: paused, request: answered };
}

export async function planAutoExecutionUnitSwitch(
  root, flightId, toExecutionUnit, reason, options = {}
) {
  const state = await readAutoFlightState(root, flightId);
  assertSwitchQuiescence(state);
  const { definition } = options.loadStoryAuthority
    ? await options.loadStoryAuthority(state) : await loadPinnedStoryAuthority(state);
  const target = String(toExecutionUnit ?? '').trim();
  if (!definition.models?.providers?.[target]) {
    fail(`Execution Unit '${target}' is not an approved provider.`, 'AUTO_EXECUTION_UNIT_UNAVAILABLE', {
      available: Object.keys(definition.models?.providers ?? {})
    });
  }
  const attempts = await records(root, 'auto-attempt', flightId);
  const parent = attempts.find((entry) => entry.attemptId === state.activeAttemptId);
  if (!parent) fail('Execution Unit switching requires an exact parent attempt.', 'AUTO_SWITCH_PARENT_REQUIRED');
  const fromExecutionUnit = state.executionUnit?.id ?? definition.models.defaultProvider;
  const switchPlan = await persistAutoExecutionUnitSwitch(root, {
    flightId, fromExecutionUnit, toExecutionUnit: target,
    taskContractSha256: parent.taskContractSha256, parentAttemptId: parent.attemptId,
    reason: String(reason ?? '').trim() || 'developer-selected-alternate-unit', status: 'proposed'
  });
  return { flight: state, parentAttempt: parent, switchPlan };
}

export async function confirmAutoExecutionUnitSwitch(
  root, flightId, switchPlanId, confirmation, options = {}
) {
  const plan = await readAutoP1Record(root, 'auto-execution-unit-switch', flightId, switchPlanId);
  const state = await readAutoFlightState(root, flightId);
  const applied = state.executionUnitSwitches?.find((entry) => entry.switchPlanId === switchPlanId);
  if (applied && state.executionUnit?.switchPlanSha256 === confirmation) {
    const attempt = await readAutoP1Record(root, 'auto-attempt', flightId, applied.attemptId);
    const switchPlan = plan.status === 'applied' ? plan
      : await updateAutoExecutionUnitSwitch(
        root, flightId, switchPlanId, { status: 'applied' },
        { expectedSwitchPlanSha256: plan.switchPlanSha256 }
      );
    if (applied.checkpointSha256) {
      return { flight: state, switchPlan, attempt, replayed: true };
    }
    const checkpointed = await publishControlBoundary(root, state, options, (draft, pointer) => {
      const entry = draft.executionUnitSwitches.find((item) => item.switchPlanId === switchPlanId);
      if (entry) {
        entry.checkpointSha256 = pointer.checkpointSha256;
        entry.checkpointCommit = pointer.commit;
      }
    });
    return { flight: checkpointed, switchPlan, attempt, replayed: true };
  }
  if (exactHash(confirmation, 'Execution Unit switch confirmation') !== plan.switchPlanSha256) {
    fail(`Switch confirmation must equal ${plan.switchPlanSha256}.`, 'AUTO_SWITCH_CONFIRMATION_REQUIRED', {
      expected: plan.switchPlanSha256
    });
  }
  assertSwitchQuiescence(state);
  if (plan.status !== 'proposed') {
    fail(`Execution Unit switch '${switchPlanId}' is ${plan.status}, not proposed.`,
      'AUTO_SWITCH_STALE');
  }
  const { definition } = options.loadStoryAuthority
    ? await options.loadStoryAuthority(state) : await loadPinnedStoryAuthority(state);
  const provider = definition.models?.providers?.[plan.toExecutionUnit];
  if (!provider) fail(`Execution Unit '${plan.toExecutionUnit}' is no longer approved.`, 'AUTO_EXECUTION_UNIT_UNAVAILABLE');
  const currentExecutionUnit = state.executionUnit?.id ?? definition.models?.defaultProvider;
  if (currentExecutionUnit !== plan.fromExecutionUnit
      || state.activeAttemptId !== plan.parentAttemptId) {
    fail('Execution Unit switch authority changed after the proposal was created.',
      'AUTO_SWITCH_STALE', {
        expectedExecutionUnit: plan.fromExecutionUnit, currentExecutionUnit,
        expectedAttemptId: plan.parentAttemptId, activeAttemptId: state.activeAttemptId
      });
  }
  const attempts = await records(root, 'auto-attempt', flightId);
  const parent = attempts.find((entry) => entry.attemptId === plan.parentAttemptId);
  if (!parent) fail('Execution Unit switch parent attempt is unavailable.', 'AUTO_SWITCH_PARENT_REQUIRED');
  if (parent.taskContractSha256 !== plan.taskContractSha256) {
    fail('Execution Unit switch Task Contract no longer matches its parent attempt.',
      'AUTO_SWITCH_STALE', {
        expected: plan.taskContractSha256, actual: parent.taskContractSha256
      });
  }
  const priorAttempt = attempts.find((entry) => entry.reason === `execution-unit-switch:${plan.switchPlanId}`);
  const attempt = priorAttempt ?? buildAutoAttempt({
    flightId, phase: parent.phase, attemptNumber: attempts.filter((entry) => entry.phase === parent.phase).length + 1,
    attemptKind: 'resume', parentAttemptId: parent.attemptId,
    reason: `execution-unit-switch:${plan.switchPlanId}`,
    generationIntentSha256: parent.generationIntentSha256,
    taskContractSha256: plan.taskContractSha256,
    contextManifestSha256: parent.contextManifestSha256,
    executionUnitManifestSha256: digest({ id: plan.toExecutionUnit, provider }),
    status: 'planned', budgetImpact: { modelInvocations: 0, routeChanges: 1 }, result: null
  });
  if (!priorAttempt) await persistAutoAttempt(root, attempt);
  const switched = await mutateAutoFlightState(root, flightId, (draft) => {
    draft.executionUnit = {
      id: plan.toExecutionUnit,
      manifestSha256: digest({ id: plan.toExecutionUnit, provider }),
      switchPlanId: plan.switchPlanId, switchPlanSha256: plan.switchPlanSha256
    };
    draft.executionUnitSwitches = [...(draft.executionUnitSwitches ?? []), {
      switchPlanId: plan.switchPlanId, from: plan.fromExecutionUnit, to: plan.toExecutionUnit,
      parentAttemptId: plan.parentAttemptId, attemptId: attempt.attemptId
    }];
    draft.activeAttemptId = attempt.attemptId;
    draft.attemptIds = [...new Set([...(draft.attemptIds ?? []), attempt.attemptId])];
    draft.stopReason = 'execution-unit-switched';
    draft.nextAction = 'Resume with the exact checkpoint hash to create a new lineage-linked attempt.';
  }, { expectedCheckpoint: state.checkpointSha256 });
  const appliedPlan = await updateAutoExecutionUnitSwitch(
    root, flightId, switchPlanId, { status: 'applied' },
    { expectedSwitchPlanSha256: plan.switchPlanSha256 }
  );
  const checkpointed = await publishControlBoundary(root, switched, options, (draft, pointer) => {
    const entry = draft.executionUnitSwitches.find((item) => item.switchPlanId === switchPlanId);
    if (entry) {
      entry.checkpointSha256 = pointer.checkpointSha256;
      entry.checkpointCommit = pointer.commit;
    }
  });
  return { flight: checkpointed, switchPlan: appliedPlan, attempt };
}
