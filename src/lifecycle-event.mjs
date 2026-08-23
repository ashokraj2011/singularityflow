import { createHash, randomUUID } from 'node:crypto';
import { SingularityFlowError, nowIso } from './util.mjs';
import {
  LIFECYCLE_EVENT, LIFECYCLE_EVENT_VOCABULARY
} from './vocabularies/catalog.mjs';

export { LIFECYCLE_EVENT, LIFECYCLE_EVENT_VOCABULARY };
export const LIFECYCLE_EVENT_TYPES = LIFECYCLE_EVENT_VOCABULARY.values;

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
  const descriptor = LIFECYCLE_EVENT_VOCABULARY.descriptors[type];
  if (!descriptor) {
    throw new SingularityFlowError(
      `Lifecycle write refused: vocabulary '${LIFECYCLE_EVENT_VOCABULARY.id}' does not own member '${type}'. No lifecycle authority was recorded. Source, artifacts, tests, and any valid generation intent are preserved. Upgrade Singularity Flow or remove the invalid first-party emitter, then retry the operation.`,
      {
        code: 'VOCABULARY_MEMBER_UNKNOWN',
        details: {
          status: 'refused',
          scope: { operation: 'lifecycle.write', subject: subject ?? null, repositoryWide: false },
          vocabulary: {
            id: LIFECYCLE_EVENT_VOCABULARY.id,
            installedVersion: LIFECYCLE_EVENT_VOCABULARY.version,
            installedSha256: LIFECYCLE_EVENT_VOCABULARY.manifest.sha256,
            member: type
          },
          authority: { wouldCreateAuthority: true, recorded: false },
          workPreserved: { source: true, artifact: true, tests: true, generationIntent: true },
          allowedOperations: ['status', 'show', 'edit', 'test', 'phase.begin']
        }
      }
    );
  }
  if (!descriptor.writeAllowed) {
    throw new SingularityFlowError(`Lifecycle member '${type}' is retained for reads but cannot be written.`, {
      code: 'VOCABULARY_MEMBER_NOT_WRITABLE',
      details: { vocabulary: LIFECYCLE_EVENT_VOCABULARY.id, member: type }
    });
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

export function recordPublicationProjection(aggregate, event, ledgerIntent = null) {
  aggregate.publicationProjections ??= [];
  if (aggregate.publicationProjections.some((entry) => entry.event?.eventId === event.eventId)) return aggregate;
  const projectedIntent = ledgerIntent ? structuredClone(ledgerIntent) : null;
  if (projectedIntent && !projectedIntent.payload?.lifecycleEvent) {
    projectedIntent.payload = {
      ...(projectedIntent.payload ?? {}),
      lifecycleEvent: structuredClone(event)
    };
  }
  aggregate.publicationProjections.push({
    schemaVersion: 1,
    event: structuredClone(event),
    ledgerIntent: projectedIntent
  });
  return aggregate;
}
