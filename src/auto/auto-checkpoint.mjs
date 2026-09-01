/** Governed Auto boundary checkpoints and recovery of their machine-local projection. */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { applicationPathContext } from '../application-paths.mjs';
import { activatePhaseAgent } from '../commands/kernel.mjs';
import { branch, gitCommonDir, head } from '../git.mjs';
import { assertCredentialFreeRemote, configuredRemoteIdentity } from '../git-remote-diagnostics.mjs';
import { runRemoteGit } from '../git-execution.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { loadStoryAggregate, transactStory } from '../state-stores.mjs';
import { nowIso, posix, run, SingularityFlowError, writeAtomic } from '../util.mjs';
import { readVerifiedAcceptedAutoBinding } from './auto-origin.mjs';
import {
  discoverAutoCandidateRecoveryAuthority, publishAutoCandidateAuthority,
  readAutoCandidateBinding,
  readAutoCandidateVerification, restoreAutoCandidateAuthority,
  restoreAutoCandidateWorktree, validateAutoCandidateBinding,
  validateAutoCandidateVerification
} from './auto-candidate.mjs';
import { verifyAutoFlightContinuation } from './auto-continuation.mjs';
import {
  createAutoFlightState, mutateAutoFlightState, readAutoFlightReport, readAutoFlightState,
  restoreAutoFlightReport
} from './auto-flight-store.mjs';
import { restoreAutoP1Records, snapshotAutoP1Records } from './auto-p1-records.mjs';

const CHECKPOINT_CLASSES = new Set([
  'phase-boundary', 'human-boundary', 'publication-boundary', 'recovery', 'completion'
]);
const FLIGHT_ID = /^AFL-[A-F0-9]{26}$/;
const PLAN_ID = /^APL-[A-F0-9]{26}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const CHECKPOINT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'mode', 'checkpointClass', 'flightId', 'planId',
  'planSha256', 'story', 'position', 'status', 'stopReason', 'execution',
  'capabilityId', 'scopePrediction', 'configuration', 'repositories',
  'completedOperations', 'commits', 'evidence', 'counters',
  'lastSuccessfulStoryRevision', 'phaseContracts', 'phaseContractSha256',
  'candidate', 'candidateBinding', 'candidateVerification',
  'runtime', 'lineage', 'finalReportSha256', 'finalReport',
  'flightCreatedAt', 'createdAt', 'checkpointSha256'
]);
const RUNTIME_KEYS = Object.freeze([
  'lastInvocationId', 'token', 'observedPaths', 'touchedPaths', 'ceiling', 'quality',
  'approvals', 'lastError', 'activePhaseRunId', 'activeAttemptId', 'activeRefusalId',
  'activeRepairPlanId', 'activeRepair', 'phaseRunIds', 'attemptIds', 'refusalIds',
  'repairAttempts', 'failureComparison', 'openHumanRequestIds', 'humanRequestDecisions',
  'executionUnit', 'executionUnitSwitches', 'worldModelReference',
  'comprehensionReference'
]);
const LINEAGE_KEYS = Object.freeze([
  'auto-phase-run', 'auto-attempt', 'auto-refusal', 'auto-repair-plan',
  'auto-human-request', 'auto-token-economics-receipt', 'auto-execution-unit-switch'
]);

function allowedRecoveryPath(actual, predicted) {
  return predicted.some((candidate) => actual === candidate
    || actual.startsWith(`${candidate.replace(/\/$/, '')}/`));
}

function checkpointHash(record) {
  const copy = structuredClone(record);
  delete copy.checkpointSha256;
  return `sha256:${recordSha256(copy)}`;
}

export function validateAutoBoundaryCheckpoint(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new SingularityFlowError('Auto boundary checkpoint must be an object.', {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  const allowed = new Set(CHECKPOINT_KEYS);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  const storyKeys = new Set([
    'workId', 'branch', 'phase', 'generation', 'status', 'workflowSha256',
    'sourceRevision'
  ]);
  const storyExtra = record.story && typeof record.story === 'object'
    ? Object.keys(record.story).filter((key) => !storyKeys.has(key)) : ['story'];
  const runtimeExtra = record.runtime && typeof record.runtime === 'object'
    ? Object.keys(record.runtime).filter((key) => !RUNTIME_KEYS.includes(key)) : ['runtime'];
  const lineageExtra = record.lineage && typeof record.lineage === 'object'
    ? Object.keys(record.lineage).filter((key) => !LINEAGE_KEYS.includes(key)) : ['lineage'];
  let candidateBinding = null;
  let candidateVerification = null;
  try {
    candidateBinding = record.candidateBinding == null
      ? null : validateAutoCandidateBinding(record.candidateBinding);
    candidateVerification = record.candidateVerification == null
      ? null : validateAutoCandidateVerification(record.candidateVerification);
  } catch {
    candidateBinding = Symbol.for('invalid-auto-candidate-binding');
  }
  if (extra.length || storyExtra.length
      || record.kind !== 'auto-boundary-checkpoint' || record.mode !== 'auto'
      || !CHECKPOINT_CLASSES.has(record.checkpointClass)
      || !FLIGHT_ID.test(String(record.flightId ?? ''))
      || !PLAN_ID.test(String(record.planId ?? ''))
      || !HASH.test(String(record.planSha256 ?? ''))
      || !record.story || typeof record.story.workId !== 'string' || !record.story.workId
      || typeof record.story.branch !== 'string' || !record.story.branch
      || typeof record.story.phase !== 'string' || !record.story.phase
      || (record.story.generation != null
        && (!Number.isSafeInteger(record.story.generation) || record.story.generation < 0))
      || (record.story.status != null && typeof record.story.status !== 'string')
      || !HASH.test(String(record.story.workflowSha256 ?? ''))
      || typeof record.story.sourceRevision !== 'string' || !record.story.sourceRevision
      || typeof record.position !== 'string' || !record.position
      || !['paused', 'waiting-human', 'manual-takeover', 'recovery-required', 'halted', 'completed']
        .includes(record.status)
      || typeof record.stopReason !== 'string'
      || !Array.isArray(record.scopePrediction) || !Array.isArray(record.repositories)
      || !Array.isArray(record.completedOperations)
      || !record.commits || typeof record.commits !== 'object' || Array.isArray(record.commits)
      || !record.evidence || typeof record.evidence !== 'object' || Array.isArray(record.evidence)
      || !record.counters || typeof record.counters !== 'object' || Array.isArray(record.counters)
      || !record.phaseContracts || typeof record.phaseContracts !== 'object'
      || Array.isArray(record.phaseContracts)
      || (record.phaseContractSha256 != null
        && !HASH.test(String(record.phaseContractSha256)))
      || (record.candidate != null
        && (typeof record.candidate !== 'object' || Array.isArray(record.candidate)))
      || (record.candidate == null) !== (candidateBinding == null)
      || (record.candidate != null && (
        typeof candidateBinding !== 'object'
        || candidateBinding.flightId !== record.flightId
        || candidateBinding.candidateId !== record.candidate.candidateId
        || candidateBinding.candidateSha256 !== record.candidate.candidateSha256
        || candidateBinding.bindingSha256 !== record.candidate.bindingSha256
        || candidateBinding.attemptId !== record.candidate.attemptId
        || candidateBinding.applicationChangeSetDigest
          !== record.candidate.applicationChangeSetDigest
        || candidateBinding.applicationResourceDigest
          !== record.candidate.applicationResourceDigest
      ))
      || (candidateVerification != null && (
        candidateBinding == null
        || candidateVerification.flightId !== record.flightId
        || candidateVerification.candidateId !== candidateBinding.candidateId
        || candidateVerification.candidateSha256 !== candidateBinding.candidateSha256
        || candidateVerification.bindingSha256 !== candidateBinding.bindingSha256
        || candidateVerification.verificationReceiptSha256
          !== record.candidate?.verificationReceiptSha256
      ))
      || (record.candidate?.verificationReceiptSha256 != null)
        !== (candidateVerification != null)
      || runtimeExtra.length || lineageExtra.length
      || RUNTIME_KEYS.some((key) => !Object.hasOwn(record.runtime ?? {}, key))
      || LINEAGE_KEYS.some((key) => !Array.isArray(record.lineage?.[key]))
      || (record.finalReportSha256 != null
        && !HASH.test(String(record.finalReportSha256)))
      || (record.finalReport == null) !== (record.finalReportSha256 == null)
      || (record.finalReport != null
        && (record.finalReport.kind !== 'auto-flight-report'
          || record.finalReport.flightId !== record.flightId
          || record.finalReport.planSha256 !== record.planSha256
          || record.finalReport.reportSha256 !== record.finalReportSha256
          || record.finalReport.reportSha256 !== `sha256:${recordSha256((() => {
            const core = structuredClone(record.finalReport);
            delete core.reportSha256;
            return core;
          })())}`))
      || Number.isNaN(Date.parse(record.flightCreatedAt))
      || Number.isNaN(Date.parse(record.createdAt))
      || !HASH.test(String(record.checkpointSha256 ?? ''))
      || record.checkpointSha256 !== checkpointHash(record)) {
    throw new SingularityFlowError('Auto boundary checkpoint failed its closed contract.', {
      code: 'AUTO_CHECKPOINT_INVALID', details: {
        extra, storyExtra, runtimeExtra, lineageExtra
      }
    });
  }
  return Object.freeze(structuredClone(record));
}

function workflowHash(workflow) {
  const copy = structuredClone(workflow);
  return `sha256:${recordSha256(copy)}`;
}

function boundaryRestingStatus(checkpointClass, state) {
  if (checkpointClass === 'completion') return 'completed';
  if (checkpointClass === 'recovery') return 'recovery-required';
  if (checkpointClass === 'human-boundary') {
    return ['paused', 'waiting-human', 'manual-takeover', 'halted'].includes(state.status)
      ? state.status : 'waiting-human';
  }
  return 'paused';
}

export async function buildAutoBoundaryCheckpoint(
  state, checkpointClass, workflow, {
    operationalRoot = state.worktree,
    candidateBinding: suppliedCandidateBinding = null,
    candidateVerification: suppliedCandidateVerification = null
  } = {}
) {
  if (!CHECKPOINT_CLASSES.has(checkpointClass)) {
    throw new SingularityFlowError(`Unknown Auto checkpoint class '${checkpointClass}'.`, {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  const phase = workflow.phases?.[state.story.phase] ?? null;
  const finalReport = ['completed', 'halted'].includes(state.status)
      && state.finalReportSha256
    ? await readAutoFlightReport(operationalRoot, state.flightId) : null;
  if (finalReport && finalReport.reportSha256 !== state.finalReportSha256) {
    throw new SingularityFlowError('Auto final report changed before its governed checkpoint.', {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  const candidateBinding = state.candidate
    ? suppliedCandidateBinding ?? await readAutoCandidateBinding(state.worktree, {
      flightId: state.flightId, candidateId: state.candidate.candidateId
    })
    : null;
  const candidateVerification = state.candidate?.verificationReceiptSha256
    ? suppliedCandidateVerification ?? await readAutoCandidateVerification(state.worktree, {
      flightId: state.flightId, candidateId: state.candidate.candidateId,
      verificationReceiptSha256: state.candidate.verificationReceiptSha256
    })
    : null;
  const record = {
    schemaVersion: currentSchemaVersion('auto-boundary-checkpoint'),
    kind: 'auto-boundary-checkpoint', mode: 'auto', checkpointClass,
    flightId: state.flightId, planId: state.planId, planSha256: state.planSha256,
    story: {
      workId: state.story.workId, branch: state.story.branch,
      phase: state.story.phase, generation: phase?.generation ?? null,
      status: phase?.status ?? workflow.status ?? null,
      workflowSha256: workflowHash(workflow), sourceRevision: head(state.worktree)
    },
    position: state.position,
    status: boundaryRestingStatus(checkpointClass, state),
    stopReason: state.stopReason,
    execution: structuredClone(state.execution),
    capabilityId: state.capabilityId ?? null,
    scopePrediction: structuredClone(state.scopePrediction ?? []),
    configuration: structuredClone(state.configuration ?? null),
    repositories: structuredClone(state.repositories ?? []),
    completedOperations: structuredClone(state.operations ?? []),
    commits: structuredClone(state.commits ?? {}),
    evidence: structuredClone(state.evidence ?? {}),
    counters: structuredClone(state.counters),
    lastSuccessfulStoryRevision: state.lastSuccessfulStoryRevision ?? null,
    phaseContracts: structuredClone(state.phaseContracts ?? {}),
    phaseContractSha256: state.evidence?.phaseContractSha256 ?? null,
    candidate: structuredClone(state.candidate ?? null),
    candidateBinding: structuredClone(candidateBinding),
    candidateVerification: structuredClone(candidateVerification),
    runtime: {
      lastInvocationId: state.lastInvocationId ?? null,
      token: structuredClone(state.token ?? null),
      observedPaths: structuredClone(state.observedPaths ?? []),
      touchedPaths: structuredClone(state.touchedPaths ?? []),
      ceiling: structuredClone(state.ceiling ?? null),
      quality: structuredClone(state.quality ?? []),
      approvals: structuredClone(state.approvals ?? []),
      lastError: structuredClone(state.lastError ?? null),
      activePhaseRunId: state.activePhaseRunId ?? null,
      activeAttemptId: state.activeAttemptId ?? null,
      activeRefusalId: state.activeRefusalId ?? null,
      activeRepairPlanId: state.activeRepairPlanId ?? null,
      activeRepair: structuredClone(state.activeRepair ?? null),
      phaseRunIds: structuredClone(state.phaseRunIds ?? []),
      attemptIds: structuredClone(state.attemptIds ?? []),
      refusalIds: structuredClone(state.refusalIds ?? []),
      repairAttempts: structuredClone(state.repairAttempts ?? []),
      failureComparison: structuredClone(state.failureComparison ?? null),
      openHumanRequestIds: structuredClone(state.openHumanRequestIds ?? []),
      humanRequestDecisions: structuredClone(state.humanRequestDecisions ?? []),
      executionUnit: structuredClone(state.executionUnit ?? null),
      executionUnitSwitches: structuredClone(state.executionUnitSwitches ?? []),
      worldModelReference: structuredClone(state.worldModelReference ?? null),
      comprehensionReference: structuredClone(state.comprehensionReference ?? null)
    },
    lineage: await snapshotAutoP1Records(operationalRoot, state.flightId),
    finalReportSha256: finalReport?.reportSha256 ?? null,
    finalReport,
    flightCreatedAt: state.createdAt,
    createdAt: nowIso(),
    checkpointSha256: null
  };
  record.checkpointSha256 = checkpointHash(record);
  return validateAutoBoundaryCheckpoint(
    readRecord('auto-boundary-checkpoint', record).record
  );
}

function checkpointRelative(definition, state, record) {
  const sequence = String((state.boundaryCheckpoints?.length ?? 0) + 1).padStart(6, '0');
  return posix(path.join(
    definition.workItemRoot ?? 'singularity/work-items', state.story.workId,
    'context', 'auto', 'checkpoints',
    `${sequence}-${record.checkpointClass}-${record.checkpointSha256.slice(7, 19)}.json`
  ));
}

/** Publish one checkpoint as Story evidence in the ordinary transactional commit/push path. */
export async function publishAutoBoundaryCheckpoint(storyRoot, state, checkpointClass, options = {}) {
  const definition = options.definition ?? await loadDefinition(storyRoot);
  const workflow = options.workflow
    ?? await loadStoryAggregate(storyRoot, definition, state.story.workId);
  const candidateBinding = state.candidate
    ? await readAutoCandidateBinding(storyRoot, {
      flightId: state.flightId, candidateId: state.candidate.candidateId
    })
    : null;
  const candidateVerification = state.candidate?.verificationReceiptSha256
    ? await readAutoCandidateVerification(storyRoot, {
      flightId: state.flightId, candidateId: state.candidate.candidateId,
      verificationReceiptSha256: state.candidate.verificationReceiptSha256
    })
    : null;
  if (candidateBinding) {
    await publishAutoCandidateAuthority(storyRoot, candidateBinding, {
      remote: state.repositories?.[0]?.remote ?? 'origin'
    });
  }
  for (const projection of [...(workflow.publicationProjections ?? [])].reverse()) {
    const payload = projection.event?.payload;
    if (projection.event?.type !== LIFECYCLE_EVENT.EVIDENCE_RECORDED
        || payload?.kind !== 'auto-boundary-checkpoint'
        || payload?.flightId !== state.flightId
        || payload?.checkpointClass !== checkpointClass) continue;
    const prior = await readGovernedAutoCheckpoint(storyRoot, workflow, projection);
    if (prior.record.story.phase === state.story.phase
        && prior.record.position === state.position
        && prior.record.story.sourceRevision === state.lastSuccessfulStoryRevision) return prior;
    break;
  }
  const record = await buildAutoBoundaryCheckpoint(state, checkpointClass, workflow, {
    operationalRoot: options.operationalRoot ?? storyRoot,
    candidateBinding, candidateVerification
  });
  const relative = checkpointRelative(definition, state, record);
  const existing = [...(workflow.publicationProjections ?? [])].reverse().find((projection) => (
    projection.event?.type === LIFECYCLE_EVENT.EVIDENCE_RECORDED
      && projection.event?.payload?.kind === 'auto-boundary-checkpoint'
      && projection.event?.payload?.flightId === state.flightId
      && projection.event?.payload?.checkpointSha256 === record.checkpointSha256
      && projection.event?.payload?.path === relative
  ));
  if (existing) {
    return readGovernedAutoCheckpoint(storyRoot, workflow, existing);
  }
  const { publication } = await transactStory(
    storyRoot,
    definition,
    workflow,
    {
      type: LIFECYCLE_EVENT.EVIDENCE_RECORDED,
      phaseId: state.story.phase,
      payload: {
        kind: 'auto-boundary-checkpoint', checkpointClass, flightId: state.flightId,
        planSha256: state.planSha256, path: relative,
        checkpointSha256: record.checkpointSha256
      }
    },
    `[${state.story.workId}][auto:checkpoint] ${checkpointClass}`,
    async () => {
      await writeAtomic(path.join(storyRoot, relative), canonicalJson(record));
      return record;
    },
    { paths: [relative] }
  );
  return Object.freeze({
    checkpointClass, path: relative, checkpointSha256: record.checkpointSha256,
    commit: publication.sha, eventId: publication.event.eventId,
    phase: state.story.phase, position: state.position, createdAt: record.createdAt,
    record
  });
}

async function committedPath(root, relative) {
  const result = run('git', ['log', '-1', '--format=%H', '--', relative], {
    cwd: root, allowFailure: true
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function readGovernedAutoCheckpoint(storyRoot, workflow, projection) {
  const payload = projection?.event?.payload;
  if (projection?.event?.type !== LIFECYCLE_EVENT.EVIDENCE_RECORDED
      || payload?.kind !== 'auto-boundary-checkpoint'
      || typeof payload.path !== 'string') {
    throw new SingularityFlowError('Story projection is not an Auto boundary checkpoint.', {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  const acceptedPlanPath = path.resolve(storyRoot, workflow.auto?.acceptedPlanPath ?? '');
  const itemRoot = path.dirname(path.dirname(path.dirname(acceptedPlanPath)));
  const target = path.resolve(storyRoot, payload.path);
  if (!workflow.auto?.acceptedPlanPath || path.basename(itemRoot) !== workflow.workItem.id
      || !target.startsWith(`${itemRoot}${path.sep}`)) {
    throw new SingularityFlowError('Auto checkpoint path escapes its governed Story.', {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  const commit = await committedPath(storyRoot, payload.path);
  if (!commit || run('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
    cwd: storyRoot, allowFailure: true
  }).status !== 0) {
    throw new SingularityFlowError('Auto checkpoint is not contained in the governed Story history.', {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  const shown = run('git', ['show', `${commit}:${payload.path}`], {
    cwd: storyRoot, allowFailure: true
  });
  if (shown.status !== 0) {
    throw new SingularityFlowError('Auto checkpoint bytes are unavailable from their governed commit.', {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  let stored;
  try { stored = JSON.parse(shown.stdout); }
  catch {
    throw new SingularityFlowError('Auto checkpoint is not valid JSON.', {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  // Verify the exact historical bytes before migration. Additive migrations can shape old data for
  // readers, but must never manufacture a valid checkpoint digest for altered stored bytes.
  if (stored.checkpointSha256 !== checkpointHash(stored)) {
    throw new SingularityFlowError('Auto checkpoint failed its historical content hash.', {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  const record = validateAutoBoundaryCheckpoint(
    readRecord('auto-boundary-checkpoint', stored).record
  );
  if (record.kind !== 'auto-boundary-checkpoint' || record.mode !== 'auto'
      || record.flightId !== payload.flightId
      || record.checkpointClass !== payload.checkpointClass
      || record.checkpointSha256 !== payload.checkpointSha256
      || record.checkpointSha256 !== checkpointHash(record)) {
    throw new SingularityFlowError('Auto checkpoint failed its governed digest binding.', {
      code: 'AUTO_CHECKPOINT_INVALID'
    });
  }
  return Object.freeze({
    checkpointClass: record.checkpointClass, path: payload.path,
    checkpointSha256: record.checkpointSha256, commit,
    eventId: projection.event.eventId, phase: record.story.phase,
    position: record.position, createdAt: record.createdAt, record
  });
}

export async function discoverLatestGovernedAutoCheckpoint(storyRoot, workflow, flightId) {
  const projections = [...(workflow.publicationProjections ?? [])].reverse().filter((projection) => (
    projection.event?.type === LIFECYCLE_EVENT.EVIDENCE_RECORDED
      && projection.event?.payload?.kind === 'auto-boundary-checkpoint'
      && projection.event?.payload?.flightId === flightId
  ));
  if (!projections.length) {
    throw new SingularityFlowError(`Story '${workflow.workItem.id}' has no governed checkpoint for Auto flight '${flightId}'.`, {
      code: 'AUTO_CHECKPOINT_NOT_FOUND'
    });
  }
  return readGovernedAutoCheckpoint(storyRoot, workflow, projections[0]);
}

async function ensureManagedRecoveryCheckout(controlRoot, storyRoot, pointer) {
  const record = pointer.record;
  const managed = path.join(
    gitCommonDir(controlRoot), 'singularity-flow', 'auto-worktrees', record.flightId,
    record.repositories?.[0]?.id ?? 'repository'
  );
  const alreadyManaged = path.resolve(storyRoot) === path.resolve(managed)
    || path.resolve(storyRoot).startsWith(`${path.resolve(path.dirname(managed))}${path.sep}`);
  if (alreadyManaged) return storyRoot;
  const configured = configuredRemoteIdentity(storyRoot, record.repositories?.[0]?.remote ?? 'origin', {
    direction: 'fetch'
  });
  const remote = assertCredentialFreeRemote(
    record.repositories?.[0]?.remoteUrl ?? configured.url
  );
  await mkdir(path.dirname(managed), { recursive: true });
  const clone = runRemoteGit([
    'clone', '--single-branch', '--no-tags', '--branch', record.story.branch,
    '--', remote, managed
  ], { cwd: controlRoot, operation: 'auto-recovery-clone', allowFailure: true });
  if (clone.status !== 0) {
    throw new SingularityFlowError(`Auto recovery checkout failed: ${(clone.stderr || clone.stdout).trim()}`, {
      code: 'AUTO_RECOVERY_CHECKOUT_FAILED'
    });
  }
  if (run('git', ['merge-base', '--is-ancestor', pointer.commit, 'HEAD'], {
    cwd: managed, allowFailure: true
  }).status !== 0) {
    throw new SingularityFlowError('Recovered Story branch does not contain the governed Auto checkpoint.', {
      code: 'AUTO_RECOVERY_CHECKOUT_FAILED'
    });
  }
  return managed;
}

async function bootstrapRecoveryCheckout(controlRoot, workId, flightId) {
  if (!FLIGHT_ID.test(String(flightId ?? ''))) {
    throw new SingularityFlowError(`Invalid Auto flight ID '${flightId}'.`, {
      code: 'AUTO_FLIGHT_NOT_FOUND'
    });
  }
  const configured = configuredRemoteIdentity(controlRoot, 'origin', { direction: 'fetch' });
  if (!configured.url || configured.ambiguous) {
    throw new SingularityFlowError(
      `Auto recovery cannot resolve one credential-free origin for Story '${workId}'.`, {
        code: 'AUTO_RECOVERY_CHECKOUT_FAILED'
      }
    );
  }
  const remote = assertCredentialFreeRemote(configured.url);
  const managed = path.join(
    gitCommonDir(controlRoot), 'singularity-flow', 'auto-worktrees', flightId, 'recovery'
  );
  await mkdir(path.dirname(managed), { recursive: true });
  const clone = runRemoteGit([
    'clone', '--single-branch', '--no-tags', '--branch', workId, '--', remote, managed
  ], { cwd: controlRoot, operation: 'auto-recovery-clone', allowFailure: true });
  if (clone.status !== 0) {
    throw new SingularityFlowError(
      `Auto recovery could not materialize Story branch '${workId}': ${(clone.stderr || clone.stdout).trim()}`, {
        code: 'AUTO_RECOVERY_CHECKOUT_FAILED',
        details: { workId, flightId }
      }
    );
  }
  return managed;
}

/** Rebuild disposable .git flight state from the latest governed Story checkpoint. */
export async function rebuildAutoFlightState(controlRoot, {
  storyRoot = controlRoot, workId, flightId
}) {
  try {
    await readAutoFlightState(controlRoot, flightId);
    throw new SingularityFlowError(`Auto flight '${flightId}' already has local state.`, {
      code: 'AUTO_FLIGHT_CONFLICT'
    });
  } catch (error) {
    if (error.code !== 'AUTO_FLIGHT_NOT_FOUND') throw error;
  }
  let definition;
  let workflow;
  try {
    definition = await loadDefinition(storyRoot);
    workflow = await loadStoryAggregate(storyRoot, definition, workId);
  } catch (error) {
    if (path.resolve(storyRoot) !== path.resolve(controlRoot)) throw error;
    // A fresh clone normally has only the application base branch. Materialize the exact Story
    // branch first; its committed execution origin and checkpoint evidence are the authority used
    // below, not any reconstructed local Plan bytes.
    storyRoot = await bootstrapRecoveryCheckout(controlRoot, workId, flightId);
    definition = await loadDefinition(storyRoot);
    workflow = await loadStoryAggregate(storyRoot, definition, workId);
  }
  const pointer = await discoverLatestGovernedAutoCheckpoint(storyRoot, workflow, flightId);
  const managed = await ensureManagedRecoveryCheckout(controlRoot, storyRoot, pointer);
  if (managed !== storyRoot) {
    definition = await loadDefinition(managed);
    workflow = await loadStoryAggregate(managed, definition, workId);
  }
  const record = pointer.record;
  const acceptedBinding = await readVerifiedAcceptedAutoBinding(managed, definition, workflow, {
    flightId: record.flightId, planId: record.planId, planSha256: record.planSha256,
    story: { workId: record.story.workId }
  });
  let freezeRecovery = null;
  if (record.candidateBinding) {
    await restoreAutoCandidateAuthority(
      managed, record.candidateBinding, record.candidateVerification, {
        remote: record.repositories?.[0]?.remote ?? 'origin'
      }
    );
    // A provider can fail or be cancelled after writing but before successful authoring. That
    // preserved Candidate intentionally remains at story-created/repair-authorized so it cannot
    // be mistaken for publishable work, yet fresh-clone recovery must still reconstruct its exact
    // application bytes for human review and bounded repair.
    if (['story-created', 'repair-authorized', 'authored'].includes(record.position)) {
      await restoreAutoCandidateWorktree(
        managed, record.candidateBinding, applicationPathContext(definition, workflow)
      );
    }
  } else {
    freezeRecovery = await discoverAutoCandidateRecoveryAuthority(managed, {
      flightId: record.flightId,
      phase: record.story.phase,
      baseCheckpointSha256: pointer.checkpointSha256,
      remote: record.repositories?.[0]?.remote ?? 'origin'
    });
    if (freezeRecovery) {
      const phase = workflow.phases?.[record.story.phase];
      const expectedBaseline = phase?.generationIntent?.baseline?.commit
        ?? acceptedBinding.acceptedPlan.repositories?.[0]?.baseCommit;
      const paths = [...new Set(freezeRecovery.binding.resourceManifest.entries.flatMap((entry) => (
        [entry.oldPath, entry.newPath].filter(Boolean)
      )))].sort();
      const ceilings = record.execution?.ceilings ?? {};
      const priorPhaseAttempts = record.counters.authoringAttempts?.[record.story.phase] ?? 0;
      const priorModelInvocations = record.counters.modelInvocations ?? 0;
      if (freezeRecovery.binding.repository.baselineCommit !== expectedBaseline
          || freezeRecovery.attemptNumber !== priorPhaseAttempts + 1
          || freezeRecovery.modelInvocations !== priorModelInvocations + 1
          || (freezeRecovery.disposition === 'authored'
            && (paths.some((entry) => !allowedRecoveryPath(
              entry, acceptedBinding.acceptedPlan.proposal?.predictedPaths ?? []
            ))
              || paths.length > ceilings.maximumTouchedPaths
              || freezeRecovery.binding.resourceManifest.entries.length
                > ceilings.maximumTouchedChanges))) {
        throw new SingularityFlowError(
          'Remote Candidate recovery authority exceeds the accepted Plan or generation boundary.', {
            code: 'AUTO_CANDIDATE_RECOVERY_CONFLICT'
          }
        );
      }
      await restoreAutoCandidateWorktree(
        managed, freezeRecovery.binding, applicationPathContext(definition, workflow)
      );
    }
  }
  if (!['completed', 'halted', 'manual-takeover'].includes(record.status)) {
    const active = workflow.phases?.[workflow.currentPhase] ?? workflow.phases?.[record.story.phase];
    await activatePhaseAgent(managed, definition, record.story.workId, active);
  }
  const created = await createAutoFlightState(controlRoot, {
    flightId: record.flightId, planId: record.planId, planSha256: record.planSha256,
    capabilityId: record.capabilityId,
    status: record.status,
    story: {
      workId: record.story.workId, branch: record.story.branch,
      phase: record.story.phase, revision: pointer.commit
    },
    worktree: managed,
    scopePrediction: record.scopePrediction,
    configuration: record.configuration,
    repositories: record.repositories,
    execution: record.execution,
    position: record.position,
    stopReason: 'governed-checkpoint-rebuilt',
    nextAction: record.status === 'completed'
      ? 'The governed Auto flight is complete.'
      : 'Review the rebuilt checkpoint and resume with its exact checkpoint hash.'
  });
  const rebuilt = await mutateAutoFlightState(controlRoot, flightId, (state) => {
    state.operations = structuredClone(record.completedOperations ?? []);
    state.evidence = structuredClone(record.evidence ?? {});
    state.commits = structuredClone(record.commits ?? {});
    state.counters = structuredClone(record.counters);
    state.lastSuccessfulStoryRevision = pointer.commit;
    state.phaseContracts = structuredClone(record.phaseContracts ?? {});
    state.candidate = structuredClone(record.candidate ?? null);
    Object.assign(state, structuredClone(record.runtime));
    state.boundaryCheckpoints = [{
      checkpointClass: pointer.checkpointClass, path: pointer.path,
      checkpointSha256: pointer.checkpointSha256, commit: pointer.commit,
      eventId: pointer.eventId, phase: pointer.phase, position: pointer.position,
      createdAt: pointer.createdAt
    }];
    state.boundaryCheckpoint = state.boundaryCheckpoints[0];
    state.status = record.status;
    state.stopRequested = null;
    if (freezeRecovery) {
      const binding = freezeRecovery.binding;
      const paths = [...new Set(binding.resourceManifest.entries.flatMap((entry) => (
        [entry.oldPath, entry.newPath].filter(Boolean)
      )))].sort();
      state.candidate = {
        candidateId: binding.candidateId,
        candidateSha256: binding.candidateSha256,
        bindingSha256: binding.bindingSha256,
        attemptId: binding.attemptId,
        applicationChangeSetDigest: binding.applicationChangeSetDigest,
        applicationResourceDigest: binding.applicationResourceDigest
      };
      state.observedPaths = paths;
      state.counters.authoringAttempts[record.story.phase] = freezeRecovery.attemptNumber;
      state.counters.modelInvocations = freezeRecovery.modelInvocations;
      state.counters.touchedPaths = paths.length;
      state.counters.touchedChanges = binding.resourceManifest.entries.length;
      state.evidence = {
        ...(state.evidence ?? {}),
        changeSetDigest: binding.applicationChangeSetDigest,
        candidateSha256: binding.candidateSha256,
        candidateBindingSha256: binding.bindingSha256
      };
      state.operations = [...(state.operations ?? []), {
        operation: 'candidate-freeze', phase: record.story.phase,
        outcome: freezeRecovery.disposition === 'authored'
          ? 'fresh-clone-recovered' : 'fresh-clone-preserved-after-failure',
        candidateId: binding.candidateId,
        candidateSha256: binding.candidateSha256,
        bindingSha256: binding.bindingSha256
      }];
      if (freezeRecovery.disposition === 'authored') {
        state.position = 'authored';
        state.status = 'paused';
        state.stopReason = 'candidate-freeze-recovered';
        state.nextAction = 'Resume to verify and publish the exact recovered Candidate; no model will be invoked.';
      } else {
        state.status = 'manual-takeover';
        state.stopReason = 'failed-authoring-candidate-recovered';
        state.nextAction = 'Review and continue manually from the exact Candidate preserved after provider failure.';
      }
    }
  }, { expectedCheckpoint: created.checkpointSha256 });
  await restoreAutoP1Records(controlRoot, flightId, record.lineage);
  if (record.finalReport) await restoreAutoFlightReport(controlRoot, record.finalReport);
  try {
    // Never bless an arbitrary remote branch tail as the new checkpoint. The ordinary
    // continuation verifier accepts only the same exact revision or a machine-legal, governed
    // adjacent approval transition from the committed checkpoint.
    await verifyAutoFlightContinuation(controlRoot, rebuilt);
  } catch (error) {
    await mutateAutoFlightState(controlRoot, flightId, (state) => {
      state.status = 'recovery-required';
      state.stopReason = 'governed-checkpoint-diverged';
      state.nextAction = 'Inspect Story commits after the governed Auto checkpoint; only an exact approved phase transition can be adopted.';
      state.lastError = { code: error.code ?? 'AUTO_RECOVERY_AUTHORITY_DIVERGED', message: error.message };
    }, { expectedCheckpoint: rebuilt.checkpointSha256 });
    throw new SingularityFlowError(
      `Story '${workId}' moved beyond its governed Auto checkpoint without an adoptable phase transition.`, {
        code: 'AUTO_RECOVERY_AUTHORITY_DIVERGED', cause: error,
        details: { checkpointCommit: pointer.commit, currentHead: head(managed) }
      }
    );
  }
  return rebuilt;
}
