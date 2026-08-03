import { createHash, randomUUID } from 'node:crypto';
import { SingularityFlowError, nowIso } from './util.mjs';

export const LIFECYCLE_EVENT_TYPES = Object.freeze([
  'binding',
  'configuration-changed',
  'artifact-generated',
  'approval-requested',
  'phase-approved',
  'phase-rejected',
  'sequence-override',
  'evidence-recorded',
  'external-synchronized',
  'branch-linked',
  'telemetry-recorded',
  'projection-reconciled',
  'work-completed'
]);

export function lifecycleEvent({
  type,
  subject,
  phaseId = null,
  generation = null,
  actor = null,
  agent = null,
  authorityGroup = null,
  payload = {}
} = {}) {
  if (!LIFECYCLE_EVENT_TYPES.includes(type)) {
    throw new SingularityFlowError(`Unsupported lifecycle event type '${type}'. Allowed: ${LIFECYCLE_EVENT_TYPES.join(', ')}.`);
  }
  if (!['story', 'initiative'].includes(subject?.kind) || !String(subject?.id ?? '').trim()) {
    throw new SingularityFlowError('Lifecycle events require subject.kind story|initiative and subject.id.');
  }
  if (generation != null && (!Number.isInteger(generation) || generation < 0)) {
    throw new SingularityFlowError('Lifecycle event generation must be a non-negative integer or null.');
  }
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    type,
    subject: { ...subject, id: String(subject.id).trim() },
    phaseId,
    generation,
    actor,
    agent,
    authorityGroup,
    payload,
    sourceCommit: null,
    idempotencyKey: null,
    idempotencyHash: null,
    createdAt: nowIso()
  };
}

export function assertLifecycleEvent(event, subject) {
  const validated = lifecycleEvent({ ...event, subject: event?.subject ?? subject });
  return {
    ...validated,
    eventId: event.eventId ?? validated.eventId,
    sourceCommit: event.sourceCommit ?? null,
    idempotencyKey: event.idempotencyKey ?? null,
    idempotencyHash: event.idempotencyHash ?? null,
    createdAt: event.createdAt ?? validated.createdAt
  };
}

export function lifecycleIdempotencyKey(event, sourceCommit) {
  const commit = String(sourceCommit ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new SingularityFlowError('Lifecycle publication requires a full source commit SHA.');
  }
  const value = [
    event.subject.id,
    event.type,
    event.phaseId ?? '-',
    event.generation ?? '-',
    commit
  ].join(' · ');
  return {
    value,
    hash: createHash('sha256').update(value).digest('hex')
  };
}

export function bindLifecycleEvent(event, sourceCommit) {
  const idempotency = lifecycleIdempotencyKey(event, sourceCommit);
  return {
    ...event,
    sourceCommit: String(sourceCommit).toLowerCase(),
    idempotencyKey: idempotency.value,
    idempotencyHash: idempotency.hash
  };
}
