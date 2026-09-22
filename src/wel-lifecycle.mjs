/**
 * WEL lifecycle join and enforcement-readiness projection.
 *
 * This module does not create Candidate, Program, attempt, approval, CAB, or publication
 * authority. It validates identities supplied by those existing owners and reports the exact
 * missing joins. The installed CAB foundation accepts no authenticated evidence family, so this
 * build can never turn the projection into an enforcement decision.
 */
import { canonicalJson, recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';
import { authenticatedRunnerReadiness } from './delivery-modes/authenticated-runner-provider.mjs';
import { WEL_EXTERNAL_ENFORCEMENT_GAPS } from './wel-readiness-foundation.mjs';
import {
  unavailableWelTestLifecycle, validateWelTestLifecycle
} from './wel-test-lifecycle.mjs';
import {
  validateGvmProgram, validateGvmTaskAttempt, validateGvmTaskReceipt
} from './sgos/contracts.mjs';
import { verifySgosTaskReceipt } from './sgos/evidence.mjs';
import { verifySgosLifecycleCandidateBinding } from './sgos/candidate-lifecycle.mjs';
import {
  readSgosImmutableRecord, readSgosProcess, readSgosProgram
} from './sgos/store.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/u;
const CANDIDATE_ID = /^CAN-[A-Za-z0-9._:-]{6,127}$/u;
const ATTEMPT_ID = /^ATT-[A-Za-z0-9._:-]{1,127}$/u;
const PROCESS_ID = /^PROC-[A-Za-z0-9._:-]{1,127}$/u;

// This capability is deliberately process-local and cannot be serialized or reconstructed by a
// caller. Only verifyWelLifecycleJoin(), after reading the SGOS-owned Process and Program records,
// can mint a token accepted by the readiness projection.
const SGOS_OWNER_VERIFIED_LIFECYCLE_TOKENS = new WeakSet();

export { WEL_EXTERNAL_ENFORCEMENT_GAPS };
export { unavailableWelTestLifecycle, validateWelTestLifecycle };

function fail(message, code = 'WEL_LIFECYCLE_JOIN_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function digest(value, label) {
  if (!HASH.test(String(value ?? ''))) fail(`${label} must be a SHA-256 digest.`);
  return value;
}

function gitObject(value, label) {
  if (!GIT_OBJECT.test(String(value ?? ''))) fail(`${label} must be a full Git object ID.`);
  return value;
}

function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
    fail(`${label} has an invalid field set.`);
  }
}

function lifecycleCandidate(value) {
  const fields = [
    'candidateId', 'normalizedEventSha256', 'candidateSha256', 'retainedCandidateSha256',
    'candidateTree', 'candidateCommit', 'verificationReceiptSha256',
    'verificationProfileSha256'
  ];
  exactKeys(value, fields, 'WEL Candidate binding');
  if (!CANDIDATE_ID.test(String(value.candidateId ?? ''))) fail('WEL Candidate ID is invalid.');
  for (const field of fields.filter((entry) => entry.endsWith('Sha256'))) {
    digest(value[field], `WEL Candidate ${field}`);
  }
  gitObject(value.candidateTree, 'WEL Candidate tree');
  gitObject(value.candidateCommit, 'WEL Candidate commit');
  return structuredClone(value);
}

function reviewedApproval(value) {
  exactKeys(value, [
    'decisionSha256', 'decision', 'evidenceCommit', 'witnessMappingsSha256',
    'mappingSha256s'
  ], 'WEL approval binding');
  digest(value.decisionSha256, 'WEL approval decisionSha256');
  if (value.decision !== 'approved') fail('WEL approval binding must name an approved decision.');
  gitObject(value.evidenceCommit, 'WEL approval evidenceCommit');
  digest(value.witnessMappingsSha256, 'WEL approval witnessMappingsSha256');
  if (!Array.isArray(value.mappingSha256s) || value.mappingSha256s.length < 1
      || value.mappingSha256s.length > 1000) {
    fail('WEL approval requires 1-1000 reviewed witness mappings.');
  }
  const mappings = value.mappingSha256s.map((entry) => digest(entry, 'WEL mappingSha256')).sort();
  if (new Set(mappings).size !== mappings.length
      || canonicalJson(mappings) !== canonicalJson(value.mappingSha256s)) {
    fail('WEL reviewed mapping identities must be unique and canonically sorted.');
  }
  return structuredClone(value);
}

function publicationBinding(value, candidate) {
  exactKeys(value, [
    'status', 'publishedCommit', 'publishedTree', 'transactionSha256', 'eventSha256',
    'candidateSha256'
  ], 'WEL publication binding');
  if (!['published', 'recovery-pending'].includes(value.status)) {
    fail('WEL publication status is invalid.');
  }
  gitObject(value.publishedCommit, 'WEL publication commit');
  gitObject(value.publishedTree, 'WEL publication tree');
  digest(value.transactionSha256, 'WEL publication transactionSha256');
  digest(value.eventSha256, 'WEL publication eventSha256');
  digest(value.candidateSha256, 'WEL publication candidateSha256');
  if (value.publishedTree !== candidate.candidateTree
      || value.candidateSha256 !== candidate.candidateSha256
      || value.eventSha256 !== candidate.normalizedEventSha256) {
    fail('WEL publication does not bind the exact Candidate tree, identity, and lifecycle event.');
  }
  return structuredClone(value);
}

function attemptLineage(records, programSha256, taskReceipt) {
  if (!Array.isArray(records) || records.length < 1 || records.length > 16) {
    fail('WEL lifecycle join requires 1-16 immutable SGOS attempts.');
  }
  const attempts = records.map((entry) => validateGvmTaskAttempt(entry));
  const taskContractSha256 = attempts[0]?.taskContractSha256;
  digest(taskContractSha256, 'WEL attempt lineage taskContractSha256');
  for (const [index, attempt] of attempts.entries()) {
    if (!PROCESS_ID.test(attempt.processId) || !ATTEMPT_ID.test(attempt.attemptId)) {
      fail('WEL attempt lineage contains an invalid process or attempt identity.');
    }
    const prior = attempts[index - 1] ?? null;
    if (attempt.attemptNumber !== index + 1
        || attempt.parentAttemptId !== (prior?.attemptId ?? null)
        || (prior && (attempt.processId !== prior.processId
          || attempt.taskInstanceId !== prior.taskInstanceId
          || attempt.taskContractSha256 !== prior.taskContractSha256))) {
      fail('WEL attempt lineage is not one contiguous immutable retry chain.',
        'WEL_ATTEMPT_LINEAGE_INVALID');
    }
    if (index < attempts.length - 1 && attempt.status !== 'failed') {
      fail('A non-final WEL attempt is not terminally retryable.', 'WEL_ATTEMPT_LINEAGE_INVALID');
    }
  }
  const finalAttempt = attempts.at(-1);
  if (finalAttempt.status !== 'succeeded') {
    fail('WEL task receipt requires a succeeded terminal attempt.', 'WEL_ATTEMPT_LINEAGE_INVALID');
  }
  if (taskReceipt.processId !== finalAttempt.processId
      || taskReceipt.taskInstanceId !== finalAttempt.taskInstanceId
      || taskReceipt.attemptId !== finalAttempt.attemptId
      || taskReceipt.attemptSha256 !== finalAttempt.attemptSha256) {
    fail('WEL task receipt does not bind the terminal attempt.', 'WEL_ATTEMPT_LINEAGE_INVALID');
  }
  return {
    programSha256,
    taskContractSha256,
    processId: finalAttempt.processId,
    taskInstanceId: finalAttempt.taskInstanceId,
    attemptId: finalAttempt.attemptId,
    attemptSha256: finalAttempt.attemptSha256,
    attemptNumber: finalAttempt.attemptNumber,
    parentAttemptId: finalAttempt.parentAttemptId,
    attempts: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      attemptSha256: attempt.attemptSha256,
      attemptNumber: attempt.attemptNumber,
      parentAttemptId: attempt.parentAttemptId,
      taskContractSha256: attempt.taskContractSha256,
      reason: attempt.reason,
      status: attempt.status
    }))
  };
}

/**
 * Build a strict, read-only join over records created by existing authorities.
 *
 * The projection is intentionally observe-only: this build has no CAB attestation verifier and
 * therefore accepts no authenticatedExecution value. A later independently reviewed integration
 * must add that evidence contract before changing this invariant.
 */
export function buildWelLifecycleJoin({
  workId, phaseId, generation, testExecutionSha256, candidate, program,
  attempts, taskReceipt, approval, publication
} = {}) {
  if (typeof workId !== 'string' || !workId || typeof phaseId !== 'string' || !phaseId
      || !Number.isInteger(generation) || generation < 1) {
    fail('WEL lifecycle join requires a Story, phase, and positive generation.');
  }
  digest(testExecutionSha256, 'WEL testExecutionSha256');
  const candidateBinding = lifecycleCandidate(candidate);
  const programRecord = validateGvmProgram(program);
  const receipt = validateGvmTaskReceipt(taskReceipt);
  if (!verifySgosTaskReceipt(receipt)) fail('WEL SGOS task receipt failed exact verification.');
  if (receipt.candidateSha256 !== candidateBinding.candidateSha256) {
    fail('WEL SGOS task receipt and lifecycle Candidate differ.');
  }
  if (!receipt.evidenceRefs.includes(testExecutionSha256)) {
    fail('WEL SGOS task receipt does not bind the exact test-execution receipt.');
  }
  const lineage = attemptLineage(attempts, programRecord.programSha256, receipt);
  const approvalBinding = reviewedApproval(approval);
  if (!receipt.humanDecisionRefs.includes(approvalBinding.decisionSha256)) {
    fail('WEL SGOS task receipt does not bind the reviewed human approval.');
  }
  const published = publicationBinding(publication, candidateBinding);
  const core = {
    schemaVersion: 1, // schema-transient: read-only join projection, never stored as authority.
    kind: 'wel-lifecycle-join',
    workId, phaseId, generation, testExecutionSha256,
    candidate: candidateBinding,
    program: {
      programId: programRecord.programId,
      programSha256: programRecord.programSha256,
      policySnapshotSha256: programRecord.policySnapshotSha256
    },
    attempt: lineage,
    taskReceiptSha256: receipt.receiptSha256,
    approval: approvalBinding,
    publication: published,
    authenticatedExecution: null,
    status: 'joined-observe-only',
    enforcementEligible: false,
    gaps: [...WEL_EXTERNAL_ENFORCEMENT_GAPS]
  };
  return Object.freeze({ ...core, joinSha256: `sha256:${recordSha256(core)}` });
}

export function validateWelLifecycleJoin(value) {
  try {
    exactKeys(value, [
      'schemaVersion', 'kind', 'workId', 'phaseId', 'generation', 'testExecutionSha256',
      'candidate', 'program', 'attempt', 'taskReceiptSha256', 'approval', 'publication',
      'authenticatedExecution', 'status', 'enforcementEligible', 'gaps', 'joinSha256'
    ], 'WEL lifecycle join');
  } catch {
    return { valid: false, reason: 'join-contract-invalid' };
  }
  if (!value || value.kind !== 'wel-lifecycle-join' || value.schemaVersion !== 1 // schema-transient: read-only join projection.
      || value.status !== 'joined-observe-only' || value.enforcementEligible !== false
      || value.authenticatedExecution !== null
      || canonicalJson(value.gaps) !== canonicalJson(WEL_EXTERNAL_ENFORCEMENT_GAPS)) {
    return { valid: false, reason: 'join-contract-invalid' };
  }
  const core = structuredClone(value);
  delete core.joinSha256;
  if (!HASH.test(String(value.joinSha256 ?? ''))
      || value.joinSha256 !== `sha256:${recordSha256(core)}`) {
    return { valid: false, reason: 'join-digest-invalid' };
  }
  try {
    lifecycleCandidate(value.candidate);
    reviewedApproval(value.approval);
    publicationBinding(value.publication, value.candidate);
    digest(value.testExecutionSha256, 'WEL testExecutionSha256');
    digest(value.taskReceiptSha256, 'WEL taskReceiptSha256');
    exactKeys(value.program, [
      'programId', 'programSha256', 'policySnapshotSha256'
    ], 'WEL Program binding');
    exactKeys(value.attempt, [
      'programSha256', 'taskContractSha256', 'processId', 'taskInstanceId', 'attemptId', 'attemptSha256',
      'attemptNumber', 'parentAttemptId', 'attempts'
    ], 'WEL attempt binding');
    digest(value.program?.programSha256, 'WEL programSha256');
    digest(value.program?.policySnapshotSha256, 'WEL policySnapshotSha256');
    digest(value.attempt?.taskContractSha256, 'WEL taskContractSha256');
    if (!Array.isArray(value.attempt?.attempts) || value.attempt.attempts.length < 1
        || value.attempt.programSha256 !== value.program.programSha256
        || value.attempt.attemptId !== value.attempt.attempts.at(-1)?.attemptId
        || value.attempt.attemptSha256 !== value.attempt.attempts.at(-1)?.attemptSha256) {
      return { valid: false, reason: 'attempt-lineage-invalid' };
    }
    for (const [index, attempt] of value.attempt.attempts.entries()) {
      exactKeys(attempt, [
        'attemptId', 'attemptSha256', 'attemptNumber', 'parentAttemptId',
        'taskContractSha256', 'reason', 'status'
      ], `WEL attempt lineage entry ${index}`);
      digest(attempt.attemptSha256, `WEL attempt lineage entry ${index} digest`);
      digest(attempt.taskContractSha256,
        `WEL attempt lineage entry ${index} taskContractSha256`);
      if (!ATTEMPT_ID.test(String(attempt.attemptId ?? ''))
          || attempt.attemptNumber !== index + 1
          || attempt.parentAttemptId !== (value.attempt.attempts[index - 1]?.attemptId ?? null)
          || attempt.taskContractSha256 !== value.attempt.taskContractSha256
          || (index < value.attempt.attempts.length - 1 && attempt.status !== 'failed')
          || (index === value.attempt.attempts.length - 1 && attempt.status !== 'succeeded')) {
        return { valid: false, reason: 'attempt-lineage-invalid' };
      }
    }
  } catch {
    return { valid: false, reason: 'join-binding-invalid' };
  }
  return { valid: true, reason: null };
}

/**
 * Validate the exact SGOS-owner snapshot after its records have been independently read.
 * This pure projection validator cannot mint a readiness token; only the read path below can.
 */
export function validateWelSgosOwnerSnapshot(value, {
  process = null, program = null, attempts = [], receipt = null
} = {}) {
  const structural = validateWelLifecycleJoin(value);
  if (!structural.valid) return structural;
  try {
    const programRecord = validateGvmProgram(program);
    const attemptRecords = attempts.map((attempt) => validateGvmTaskAttempt(attempt));
    const receiptRecord = validateGvmTaskReceipt(receipt);
    const task = process?.taskInstances?.[value.attempt.taskInstanceId];
    if (process?.programSha256 !== value.program.programSha256
        || process?.policySnapshotSha256 !== value.program.policySnapshotSha256
        || process?.taskContractSha256 !== value.attempt.taskContractSha256
        || programRecord.programSha256 !== value.program.programSha256
        || task?.taskInstanceId !== value.attempt.taskInstanceId
        || task.receiptSha256 !== value.taskReceiptSha256
        || canonicalJson(task.attemptIds)
          !== canonicalJson(value.attempt.attempts.map((attempt) => attempt.attemptId))) {
      return { valid: false, reason: 'sgos-owner-binding-mismatch' };
    }
    if (attemptRecords.length !== value.attempt.attempts.length) {
      return { valid: false, reason: 'sgos-owner-attempt-mismatch' };
    }
    for (const [index, projected] of value.attempt.attempts.entries()) {
      const storedAttempt = attemptRecords[index];
      const exactProjection = {
        attemptId: storedAttempt.attemptId,
        attemptSha256: storedAttempt.attemptSha256,
        attemptNumber: storedAttempt.attemptNumber,
        parentAttemptId: storedAttempt.parentAttemptId,
        taskContractSha256: storedAttempt.taskContractSha256,
        reason: storedAttempt.reason,
        status: storedAttempt.status
      };
      if (storedAttempt.processId !== value.attempt.processId
          || storedAttempt.taskInstanceId !== value.attempt.taskInstanceId
          || canonicalJson(exactProjection) !== canonicalJson(projected)) {
        return { valid: false, reason: 'sgos-owner-attempt-mismatch' };
      }
    }
    if (!verifySgosTaskReceipt(receiptRecord, {
      processId: value.attempt.processId,
      taskInstanceId: value.attempt.taskInstanceId,
      attemptId: value.attempt.attemptId
    })
        || receiptRecord.receiptSha256 !== value.taskReceiptSha256
        || receiptRecord.attemptSha256 !== value.attempt.attemptSha256
        || receiptRecord.candidateSha256 !== value.candidate.candidateSha256
        || !receiptRecord.evidenceRefs.includes(value.testExecutionSha256)
        || !receiptRecord.humanDecisionRefs.includes(value.approval.decisionSha256)) {
      return { valid: false, reason: 'sgos-owner-receipt-mismatch' };
    }
    return { valid: true, reason: null };
  } catch (error) {
    return {
      valid: false, reason: 'sgos-owner-record-invalid', errorCode: error?.code ?? null
    };
  }
}

/** Recheck the Candidate and governed publication through SGOS's existing authority owner. */
export async function verifyWelLifecycleJoin(root, value) {
  const structural = validateWelLifecycleJoin(value);
  if (!structural.valid) return structural;
  try {
    await verifySgosLifecycleCandidateBinding(root, value.candidate, {
      publishedCommit: value.publication.publishedCommit
    });
  } catch (error) {
    return { valid: false, reason: 'candidate-publication-verification-failed', errorCode: error?.code ?? null };
  }
  try {
    const process = await readSgosProcess(root, value.attempt.processId);
    const storedProgram = await readSgosProgram(
      root, value.attempt.processId, value.program.programSha256
    );
    const storedAttempts = [];
    for (const projected of value.attempt.attempts) {
      storedAttempts.push((await readSgosImmutableRecord(
        root, value.attempt.processId, 'gvm-task-attempt', projected.attemptSha256
      )).record);
    }
    const storedReceipt = (await readSgosImmutableRecord(
      root, value.attempt.processId, 'gvm-task-receipt', value.taskReceiptSha256
    )).record;
    const ownerSnapshot = validateWelSgosOwnerSnapshot(value, {
      process, program: storedProgram.record, attempts: storedAttempts, receipt: storedReceipt
    });
    if (!ownerSnapshot.valid) return ownerSnapshot;
    const sgosOwnerVerification = Object.freeze({
      schemaVersion: 1,
      kind: 'wel-lifecycle-sgos-owner-verification',
      joinSha256: value.joinSha256,
      processSha256: process.processSha256,
      programSha256: storedProgram.record.programSha256,
      taskContractSha256: process.taskContractSha256
    });
    SGOS_OWNER_VERIFIED_LIFECYCLE_TOKENS.add(sgosOwnerVerification);
    // This token proves only records owned by Candidate/SGOS and the publication commit binding.
    // It deliberately does not claim that the phase-approval owner was read or that the complete
    // cross-authority WEL lifecycle is joined.
    return { valid: true, reason: null, sgosOwnerVerification };
  } catch (error) {
    return {
      valid: false,
      reason: 'sgos-owner-record-verification-failed',
      errorCode: error?.code ?? null
    };
  }
}

/** Read-only readiness/doctor model. No caller-provided boolean can grant enforcement. */
export function welEnforcementReadiness({
  enrollment = null, lifecycleJoin = null, lifecycleOwnerVerification = null,
  runnerProviderConfiguration = null, story = null
} = {}) {
  const cab = authenticatedRunnerReadiness(runnerProviderConfiguration);
  const joinValidation = lifecycleJoin == null
    ? { valid: false, reason: 'lifecycle-join-unavailable' }
    : validateWelLifecycleJoin(lifecycleJoin);
  const sgosOwnerVerified = joinValidation.valid
    && lifecycleOwnerVerification != null
    && SGOS_OWNER_VERIFIED_LIFECYCLE_TOKENS.has(lifecycleOwnerVerification)
    && lifecycleOwnerVerification.joinSha256 === lifecycleJoin.joinSha256;
  const explicitlyEnforced = enrollment?.mode === 'enforce'
    && enrollment?.rollout?.enrollment === 'new-story-only';
  const gaps = [...new Set([
    ...(!explicitlyEnforced ? ['WEL_ENFORCEMENT_NOT_ENROLLED'] : []),
    ...(!joinValidation.valid
      ? ['WEL_LIFECYCLE_JOIN_UNAVAILABLE']
      : !sgosOwnerVerified
        ? ['WEL_LIFECYCLE_OWNER_VERIFICATION_UNAVAILABLE']
        : ['WEL_LIFECYCLE_CROSS_AUTHORITY_VERIFICATION_UNAVAILABLE']),
    ...WEL_EXTERNAL_ENFORCEMENT_GAPS,
    ...cab.gaps
  ])];
  return Object.freeze({
    schemaVersion: 1, // schema-transient: read-only readiness/UI projection.
    kind: 'wel-enforcement-readiness',
    readinessScope: 'foundation-projection',
    lifecycleVerification: sgosOwnerVerified
      ? 'sgos-owner-verified'
      : joinValidation.valid ? 'structure-only' : 'not-loaded',
    status: 'unavailable',
    enforcementAvailable: false,
    authority: 'none',
    story: story == null ? null : Object.freeze({
      workId: String(story.workId),
      enrollmentClassification: String(story.enrollmentClassification),
      enrollmentReason: story.enrollmentReason == null ? null : String(story.enrollmentReason),
      creationCommit: story.creationCommit == null ? null : String(story.creationCommit)
    }),
    enrolled: explicitlyEnforced,
    // The current build has no complete Candidate + SGOS + approval-owner verifier. Even an SGOS
    // owner token is partial evidence and cannot turn this cross-authority join into true.
    lifecycleJoined: false,
    authenticatedRunner: cab,
    releaseEvidence: 'missing',
    recoveryAvailable: true,
    gaps: Object.freeze(gaps),
    nextActions: Object.freeze([
      { id: 'inspect-candidate', owner: 'sgos-candidate', mutation: false },
      { id: 'inspect-program-attempt-lineage', owner: 'sgos-runtime', mutation: false },
      { id: 'inspect-witness-review', owner: 'phase-approval', mutation: false },
      { id: 'inspect-publication-recovery', owner: 'publication-unit-of-work', mutation: false },
      { id: 'retry-through-sgos', owner: 'sgos-retry', mutation: true },
      { id: 'disable-for-future-stories', owner: 'reviewed-configuration', mutation: true }
    ])
  });
}

export function assertWelEnforcementAvailable(options = {}) {
  const readiness = welEnforcementReadiness(options);
  fail(
    `WEL enforcement is unavailable: ${readiness.gaps.join(', ')}.`,
    'WEL_ENFORCEMENT_UNAVAILABLE', readiness
  );
}
