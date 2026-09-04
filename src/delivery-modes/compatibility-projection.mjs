/**
 * GDP-M1 compatibility projections.
 *
 * This module is deliberately detached from every command, reader, writer, and product surface.
 * Callers must supply an already-read legacy record. Projection is synchronous, deterministic,
 * bounded, and side-effect free: it performs no Git, filesystem, lifecycle, model, AST, or
 * World-Model operation and creates no durable GDP record.
 */
import { recordSha256 } from '../records.mjs';

export const GDP_COMPATIBILITY_SOURCE_KINDS = Object.freeze([
  'workflow-story', 'auto-flight', 'adhoc-session', 'sgos-process'
]);

export const GDP_FEATURE_DEFAULTS = Object.freeze({
  compatibilityProjectionSurface: false,
  shadowChangePassport: false,
  proofObservation: false,
  outcomeMode: false,
  workflowPassport: false,
  automaticEnrollment: false,
  enforcement: false
});

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const WORKFLOW_STATUSES = new Set([
  'in_progress', 'complete', 'completed', 'cancelled', 'interrupted', 'recovery-required'
]);
const WORKFLOW_TERMINAL = new Set(['complete', 'completed', 'cancelled']);
const AUTO_TERMINAL = new Set(['halted', 'completed', 'discarded']);
const AUTO_STATUSES = new Set([
  'running', 'paused', 'waiting-human', 'manual-takeover', 'recovery-required',
  'halted', 'completed', 'discarded'
]);
const ADHOC_TERMINAL = new Set([
  'landed', 'promoted', 'split', 'local-only', 'discarded', 'cancelled'
]);
const ADHOC_STATUSES = new Set([
  'working', 'paused', 'recovery-required', ...ADHOC_TERMINAL
]);
const SGOS_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const SGOS_STATUSES = new Set([
  'queued', 'running', 'waiting-human', 'blocked', 'paused', 'recovery-required',
  ...SGOS_TERMINAL
]);

function fail(message) {
  throw new TypeError(`GDP compatibility projection: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function boundedIdentifier(value, label) {
  const result = String(value ?? '').trim();
  if (!result || result.length > 160 || /[\u0000-\u001f\u007f]/u.test(result)) {
    fail(`${label} must be a non-empty bounded identifier.`);
  }
  return result;
}

function optionalDigest(...values) {
  for (const value of values) if (SHA256.test(String(value ?? ''))) return String(value);
  return null;
}

function candidateObservation(candidate) {
  const value = candidate && typeof candidate === 'object' ? candidate : {};
  const sha256 = optionalDigest(value.candidateSha256);
  return Object.freeze({
    status: sha256 ? 'legacy' : 'unavailable',
    sha256,
    assurance: sha256 ? 'legacy' : 'unavailable'
  });
}

function worldModelObservation(reference) {
  const value = reference && typeof reference === 'object' ? reference : {};
  const sha256 = optionalDigest(
    value.manifestSha256, value.worldModelSha256
  );
  return Object.freeze({
    status: sha256 ? 'legacy' : 'unavailable',
    sha256,
    required: false,
    blocks: false
  });
}

function normalizedRecovery(value) {
  if (value == null) return Object.freeze({ status: 'not-observed', commit: null, recoveryId: null });
  object(value, 'recovery');
  const status = String(value.status ?? 'not-observed');
  if (!['not-observed', 'published', 'pending', 'recovery-required', 'unavailable'].includes(status)) {
    fail(`unsupported recovery status '${status}'.`);
  }
  const commit = value.commit == null ? null : String(value.commit);
  if (commit != null && !COMMIT.test(commit)) fail('recovery.commit must be a full Git object ID.');
  const recoveryId = value.recoveryId == null
    ? null
    : boundedIdentifier(value.recoveryId, 'recovery.recoveryId');
  if (status === 'published' && commit == null) {
    fail('published recovery metadata must identify the exact Git commit.');
  }
  if (status === 'pending' && (commit == null || recoveryId == null)) {
    fail('pending recovery metadata must identify both the exact commit and recovery marker.');
  }
  return Object.freeze({ status, commit, recoveryId });
}

function workflowProjection(record) {
  if (record.kind != null && record.kind !== 'story-workflow') fail("workflow record kind must be 'story-workflow'.");
  const subjectId = boundedIdentifier(record.workItem?.id, 'workflow workItem.id');
  const sourceStatus = String(record.status ?? 'unknown');
  const reopened = Array.isArray(record.history)
    && record.history.some((entry) => entry?.event === 'workflow_reopened');
  let normalizedStatus = WORKFLOW_STATUSES.has(sourceStatus) ? 'active' : 'unavailable';
  if (sourceStatus === 'cancelled') normalizedStatus = 'cancelled';
  else if (sourceStatus === 'complete' || sourceStatus === 'completed') {
    normalizedStatus = 'completed';
  } else if (reopened) normalizedStatus = 'reopened';
  const profile = String(record.resolution?.workflowId ?? record.workItem?.workType ?? '').trim();
  return {
    subject: { kind: 'story', id: subjectId },
    lifecycle: {
      sourceStatus,
      normalizedStatus,
      active: WORKFLOW_STATUSES.has(sourceStatus) && !WORKFLOW_TERMINAL.has(sourceStatus),
      terminal: WORKFLOW_TERMINAL.has(sourceStatus),
      reopened,
      interrupted: sourceStatus === 'interrupted' || sourceStatus === 'recovery-required',
      requiresRecovery: sourceStatus === 'recovery-required',
      currentPhase: record.currentPhase == null ? null : String(record.currentPhase)
    },
    delivery: {
      mode: 'workflow',
      workflowProfile: profile || null,
      executionPace: record.executionOrigin?.mode === 'auto' ? 'auto' : 'unavailable',
      selectionStatus: 'legacy'
    },
    runtimes: {
      workflow: 'phase-workflow-v1', execution: 'direct-phase-v1', evidence: 'delivery-evidence-v2'
    },
    candidate: candidateObservation(record.candidate ?? record.codeDelivery?.candidate),
    worldModel: worldModelObservation(record.worldModelReference ?? record.resolution?.worldModelReference)
  };
}

function autoProjection(record) {
  if (record.kind != null && record.kind !== 'auto-flight-state') fail("Auto record kind must be 'auto-flight-state'.");
  const subjectId = boundedIdentifier(record.story?.workId, 'Auto story.workId');
  const sourceStatus = String(record.status ?? 'unknown');
  const interrupted = sourceStatus === 'recovery-required'
    || (record.stopRequested != null && sourceStatus !== 'completed');
  let normalizedStatus = AUTO_STATUSES.has(sourceStatus) ? 'active' : 'unavailable';
  if (sourceStatus === 'completed') normalizedStatus = 'completed';
  else if (sourceStatus === 'discarded' || sourceStatus === 'halted') normalizedStatus = 'cancelled';
  else if (interrupted) normalizedStatus = 'interrupted';
  return {
    subject: { kind: 'story', id: subjectId },
    lifecycle: {
      sourceStatus,
      normalizedStatus,
      active: AUTO_STATUSES.has(sourceStatus) && !AUTO_TERMINAL.has(sourceStatus),
      terminal: AUTO_TERMINAL.has(sourceStatus),
      reopened: false,
      interrupted,
      requiresRecovery: sourceStatus === 'recovery-required',
      currentPhase: record.story?.phase == null ? null : String(record.story.phase)
    },
    delivery: {
      mode: 'workflow', workflowProfile: null, executionPace: 'auto', selectionStatus: 'legacy'
    },
    runtimes: {
      workflow: 'phase-workflow-v1', execution: 'auto-v2', evidence: 'delivery-evidence-v2'
    },
    candidate: candidateObservation(record.candidate),
    worldModel: worldModelObservation(record.worldModelReference)
  };
}

function adhocProjection(record) {
  if (record.kind != null && record.kind !== 'adhoc-session') fail("Ad Hoc record kind must be 'adhoc-session'.");
  const subjectId = boundedIdentifier(record.sessionId, 'Ad Hoc sessionId');
  const sourceStatus = String(record.status ?? 'unknown');
  let normalizedStatus = ADHOC_STATUSES.has(sourceStatus) ? 'active' : 'unavailable';
  if (['landed', 'promoted', 'split', 'local-only'].includes(sourceStatus)) normalizedStatus = 'completed';
  else if (['discarded', 'cancelled'].includes(sourceStatus)) normalizedStatus = 'cancelled';
  return {
    subject: { kind: 'outcome', id: subjectId },
    lifecycle: {
      sourceStatus,
      normalizedStatus,
      active: ADHOC_STATUSES.has(sourceStatus) && !ADHOC_TERMINAL.has(sourceStatus),
      terminal: ADHOC_TERMINAL.has(sourceStatus),
      reopened: false,
      interrupted: sourceStatus === 'interrupted' || sourceStatus === 'recovery-required',
      requiresRecovery: sourceStatus === 'recovery-required',
      currentPhase: null
    },
    delivery: {
      mode: 'outcome', workflowProfile: null, executionPace: 'manual', selectionStatus: 'legacy'
    },
    runtimes: { workflow: null, execution: 'adhoc-v1', evidence: 'adhoc-v1' },
    candidate: candidateObservation(record.candidate),
    worldModel: worldModelObservation(record.worldModelReference)
  };
}

function sgosProjection(record) {
  if (record.kind != null && record.kind !== 'gvm-process') fail("SGOS record kind must be 'gvm-process'.");
  const subjectId = boundedIdentifier(
    record.authorityBinding?.subjectId ?? record.processId,
    'SGOS authority subject or processId'
  );
  const subjectKind = record.authorityBinding?.kind === 'story' ? 'story' : 'outcome';
  const sourceStatus = String(record.status ?? 'unknown');
  let normalizedStatus = SGOS_STATUSES.has(sourceStatus) ? 'active' : 'unavailable';
  if (sourceStatus === 'succeeded') normalizedStatus = 'completed';
  else if (sourceStatus === 'cancelled') normalizedStatus = 'cancelled';
  else if (sourceStatus === 'failed') normalizedStatus = 'failed';
  else if (sourceStatus === 'recovery-required') normalizedStatus = 'interrupted';
  return {
    subject: { kind: subjectKind, id: subjectId },
    lifecycle: {
      sourceStatus,
      normalizedStatus,
      active: SGOS_STATUSES.has(sourceStatus) && !SGOS_TERMINAL.has(sourceStatus),
      terminal: SGOS_TERMINAL.has(sourceStatus),
      reopened: false,
      interrupted: sourceStatus === 'recovery-required',
      requiresRecovery: sourceStatus === 'recovery-required',
      currentPhase: null
    },
    delivery: {
      mode: subjectKind === 'story' ? 'workflow' : 'outcome',
      workflowProfile: null,
      executionPace: 'auto',
      selectionStatus: 'legacy'
    },
    runtimes: {
      workflow: subjectKind === 'story' ? 'phase-workflow-v1' : null,
      execution: 'gvm-v1', evidence: 'sgos-evidence-v1'
    },
    candidate: candidateObservation(record.candidate),
    worldModel: worldModelObservation(record.worldModelReference)
  };
}

const PROJECTORS = Object.freeze({
  'workflow-story': workflowProjection,
  'auto-flight': autoProjection,
  'adhoc-session': adhocProjection,
  'sgos-process': sgosProjection
});

function gap(code, status, owner, detail) {
  return Object.freeze({ code, status, owner, detail });
}

function gapsFor(projected, publication) {
  const gaps = [
    gap('GDP_LEGACY_RUNTIME_PINNED', 'legacy', 'legacy-runtime',
      'The creation-pinned legacy runtime remains authoritative.'),
    gap('GDP_PROOF_SUBJECT_UNAVAILABLE', 'unavailable', 'gdp-m2',
      'No GDP Proof Subject or Change Passport exists.'),
    gap('GDP_LEGACY_READER_REQUIRED', 'sunset-blocked', 'gdp-program',
      'The legacy reader cannot be removed while this projection must remain readable.')
  ];
  if (projected.candidate.status === 'unavailable') gaps.push(gap(
    'GDP_CANDIDATE_UNAVAILABLE', 'unavailable', 'legacy-runtime',
    'The source record does not identify an immutable Candidate.'
  ));
  if (projected.worldModel.status === 'unavailable') gaps.push(gap(
    'GDP_WORLD_MODEL_UNAVAILABLE', 'unavailable', 'wmb-v4',
    'No World Model reference is recorded; ordinary legacy work remains available.'
  ));
  if (projected.lifecycle.normalizedStatus === 'unavailable') gaps.push(gap(
    'GDP_LIFECYCLE_STATUS_UNAVAILABLE', 'unavailable', 'legacy-runtime',
    'The source status is outside the reviewed compatibility vocabulary.'
  ));
  if (publication.status === 'pending' || publication.status === 'recovery-required') gaps.push(gap(
    'GDP_PUBLICATION_RECOVERY_REQUIRED', 'legacy', 'publication-unit-of-work',
    'The existing publication recovery authority remains responsible for completion.'
  ));
  return Object.freeze(gaps);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Build a transient compatibility view over one already-verified legacy record.
 * The returned schema version is local to this transient shape and is intentionally not registered
 * with MIG. Nothing in this function authorizes, persists, publishes, or strengthens evidence.
 */
export function projectLegacyGdpCompatibility({ sourceKind, record, recovery = null } = {}) {
  const kind = String(sourceKind ?? '');
  if (!GDP_COMPATIBILITY_SOURCE_KINDS.includes(kind)) fail(`unsupported source kind '${kind}'.`);
  const source = object(record, 'record');
  const projected = PROJECTORS[kind](source);
  const publication = normalizedRecovery(recovery);
  if (publication.status === 'pending' || publication.status === 'recovery-required') {
    projected.lifecycle.normalizedStatus = 'interrupted';
    projected.lifecycle.interrupted = true;
    projected.lifecycle.requiresRecovery = true;
  }
  const core = {
    schemaVersion: 1,
    kind: 'gdp-compatibility-projection',
    classification: 'legacy',
    sourceKind: kind,
    subject: projected.subject,
    lifecycle: projected.lifecycle,
    delivery: projected.delivery,
    runtimes: projected.runtimes,
    candidate: projected.candidate,
    worldModel: projected.worldModel,
    publication,
    availability: {
      proofSubject: { status: 'unavailable', reasonCode: 'GDP_RUNTIME_NOT_INSTALLED' },
      changePassport: { status: 'unavailable', reasonCode: 'GDP_RUNTIME_NOT_INSTALLED' },
      proofSummary: { status: 'unavailable', reasonCode: 'GDP_RUNTIME_NOT_INSTALLED' }
    },
    gaps: null,
    guarantees: {
      projectionOnly: true,
      sourceRemainsAuthority: true,
      noEvidenceUpgraded: true,
      noWrites: true,
      noModel: true,
      astRequired: false,
      worldModelRequired: false
    }
  };
  core.gaps = gapsFor(projected, publication);
  const result = { ...core, projectionSha256: `sha256:${recordSha256(core)}` };
  return deepFreeze(result);
}
