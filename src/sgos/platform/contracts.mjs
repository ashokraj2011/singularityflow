import { createHash } from 'node:crypto';

import { canonicalJson } from '../../records.mjs';
import { SingularityFlowError } from '../../util.mjs';

export const SGOS_PLATFORM_FORMAT = 'sflow.sgos.platform-envelope';
export const SGOS_PLATFORM_VERSION = 1;
export const PLATFORM_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const MEMORY_CLASSES = Object.freeze([
  'input', 'shared-artifact', 'evidence', 'derived', 'approved-guidance', 'cache'
]);
export const MEMORY_SENSITIVITY = Object.freeze(['public', 'internal', 'confidential', 'restricted']);

function fail(message, code = 'SGOS_PLATFORM_CONTRACT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

export function isPlainPlatformObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function clonePlatformJson(value, location = '$', seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${location} must contain only finite numbers.`);
    return value;
  }
  if (typeof value !== 'object') fail(`${location} must be JSON-safe.`);
  if (seen.has(value)) fail(`${location} contains a cycle.`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => clonePlatformJson(entry, `${location}[${index}]`, seen));
  } else {
    if (!isPlainPlatformObject(value)) fail(`${location} must contain only plain objects.`);
    result = {};
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${location} contains unsafe key '${key}'.`);
      result[key] = clonePlatformJson(value[key], `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
  return result;
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function platformSha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : typeof value === 'string' ? value : canonicalJson(clonePlatformJson(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function platformRecordSha256(record) {
  const core = clonePlatformJson(record);
  delete core.recordSha256;
  return platformSha256(core);
}

function exactKeys(value, allowed, label) {
  if (!isPlainPlatformObject(value)) fail(`${label} must be an object.`);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) fail(`${label} contains unknown field '${key}'.`);
  }
}

function requireKeys(value, required, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing required field '${key}'.`);
  }
}

function string(value, label, pattern = null) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format.`);
}

function digest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !PLATFORM_DIGEST_PATTERN.test(value)) {
    fail(`${label} must be exactly 'sha256:' plus 64 lowercase hexadecimal characters.`);
  }
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be a safe integer >= ${minimum}.`);
}

function timestamp(value, label) {
  string(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value))) fail(`${label} must be a UTC RFC 3339 timestamp.`);
}

function identifier(value, label) {
  string(value, label, /^[a-z0-9][a-z0-9._:-]{1,127}$/);
}

function sortedUniqueStrings(value, label, { digests = false } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  for (let index = 0; index < value.length; index += 1) {
    if (digests) digest(value[index], `${label}[${index}]`);
    else string(value[index], `${label}[${index}]`);
    if (index && value[index - 1] >= value[index]) fail(`${label} must be sorted and unique.`);
  }
}

function createRecord(kind, payload, { allowed, required, validate }) {
  exactKeys(payload, allowed, kind);
  requireKeys(payload, required, kind);
  validate(payload);
  const record = { kind, ...clonePlatformJson(payload), recordSha256: null };
  record.recordSha256 = platformRecordSha256(record);
  return freezeDeep(record);
}

export function validatePlatformRecord(record, expectedKind = null) {
  if (!isPlainPlatformObject(record)) fail('Platform record must be an object.');
  string(record.kind, 'record.kind');
  if (expectedKind && record.kind !== expectedKind) fail(`Expected '${expectedKind}', received '${record.kind}'.`);
  digest(record.recordSha256, 'record.recordSha256');
  if (record.recordSha256 !== platformRecordSha256(record)) {
    fail(`Platform record '${record.kind}' failed self-hash verification.`, 'SGOS_PLATFORM_RECORD_TAMPERED');
  }
  const payload = clonePlatformJson(record);
  delete payload.kind;
  delete payload.recordSha256;
  const creator = {
    'platform-authority-state': createAuthorityState,
    'platform-authority-transaction': createAuthorityTransactionEvent,
    'platform-authority-export': createAuthorityPortableExport,
    'platform-mutation-authorization': createPlatformMutationAuthorization,
    'platform-memory-ref': createMemoryRef,
    'platform-memory-candidate': createMemoryCandidate,
    'platform-memory-promotion': createMemoryPromotion,
    'platform-secret-broker-attestation': createSecretBrokerAttestation,
    'platform-secret-handle': createSecretHandle,
    'platform-capability-pack': createCapabilityPack,
    'platform-pack-review': createPackReview,
    'platform-pack-activation': createPackActivation,
    'platform-pack-revocation': createPackRevocation,
    'platform-accepted-trace': createAcceptedTrace,
    'platform-meta-tool-candidate': createMetaToolCandidate,
    'platform-meta-tool-evaluation': createMetaToolEvaluation,
    'platform-meta-tool-promotion': createMetaToolPromotion,
    'platform-meta-tool-activation': createMetaToolActivation,
    'platform-meta-tool-observation': createMetaToolObservation,
    'platform-meta-tool-revocation': createMetaToolRevocation,
    'platform-meta-tool-rollback': createMetaToolRollback
  }[record.kind];
  if (!creator) fail(`Unknown platform record kind '${record.kind}'.`);
  const recreated = creator(payload);
  if (recreated.recordSha256 !== record.recordSha256) {
    fail(`Platform record '${record.kind}' is not canonical.`, 'SGOS_PLATFORM_RECORD_TAMPERED');
  }
  return freezeDeep(clonePlatformJson(record));
}

export function createPlatformEnvelope(record) {
  const validated = validatePlatformRecord(record);
  const envelope = {
    platformFormat: SGOS_PLATFORM_FORMAT,
    platformVersion: SGOS_PLATFORM_VERSION,
    family: validated.kind,
    recordSha256: validated.recordSha256,
    record: validated,
    envelopeSha256: null
  };
  const core = clonePlatformJson(envelope);
  delete core.envelopeSha256;
  envelope.envelopeSha256 = platformSha256(core);
  return freezeDeep(envelope);
}

export function validatePlatformEnvelope(envelope, expectedFamily = null) {
  exactKeys(envelope, [
    'platformFormat', 'platformVersion', 'family', 'recordSha256', 'record', 'envelopeSha256'
  ], 'platform envelope');
  if (envelope.platformFormat !== SGOS_PLATFORM_FORMAT || envelope.platformVersion !== SGOS_PLATFORM_VERSION) {
    fail('Platform envelope version is unsupported.', 'SGOS_PLATFORM_VERSION_UNSUPPORTED');
  }
  string(envelope.family, 'platform envelope.family');
  if (expectedFamily && envelope.family !== expectedFamily) fail(`Expected envelope family '${expectedFamily}'.`);
  digest(envelope.recordSha256, 'platform envelope.recordSha256');
  digest(envelope.envelopeSha256, 'platform envelope.envelopeSha256');
  const record = validatePlatformRecord(envelope.record, envelope.family);
  if (record.recordSha256 !== envelope.recordSha256) fail('Platform envelope record binding is invalid.', 'SGOS_PLATFORM_ENVELOPE_TAMPERED');
  const core = clonePlatformJson(envelope);
  delete core.envelopeSha256;
  if (platformSha256(core) !== envelope.envelopeSha256) fail('Platform envelope failed self-hash verification.', 'SGOS_PLATFORM_ENVELOPE_TAMPERED');
  return freezeDeep(clonePlatformJson(envelope));
}

export function createAuthorityState(input) {
  return createRecord('platform-authority-state', input, {
    allowed: ['storeId', 'revision', 'eventSha256', 'entriesSha256', 'entries'],
    required: ['storeId', 'revision', 'eventSha256', 'entriesSha256', 'entries'],
    validate(value) {
      identifier(value.storeId, 'authority state.storeId');
      integer(value.revision, 'authority state.revision');
      digest(value.eventSha256, 'authority state.eventSha256', { nullable: true });
      if ((value.revision === 0) !== (value.eventSha256 === null)) fail('Authority genesis alone may have a null event digest.');
      if (!isPlainPlatformObject(value.entries)) fail('authority state.entries must be an object.');
      for (const [key, entry] of Object.entries(value.entries)) {
        identifier(key, `authority state.entries key '${key}'`);
        clonePlatformJson(entry, `authority state.entries.${key}`);
      }
      digest(value.entriesSha256, 'authority state.entriesSha256');
      if (value.entriesSha256 !== platformSha256(value.entries)) fail('Authority entries digest is invalid.');
    }
  });
}

export function createAuthorityTransactionEvent(input) {
  return createRecord('platform-authority-transaction', input, {
    allowed: [
      'storeId', 'revision', 'priorEventSha256', 'beforeEntriesSha256', 'afterEntriesSha256',
      'actorId', 'authorization', 'committedAt', 'changes'
    ],
    required: [
      'storeId', 'revision', 'priorEventSha256', 'beforeEntriesSha256', 'afterEntriesSha256',
      'actorId', 'committedAt', 'changes'
    ],
    validate(value) {
      identifier(value.storeId, 'authority transaction.storeId');
      integer(value.revision, 'authority transaction.revision', 1);
      digest(value.priorEventSha256, 'authority transaction.priorEventSha256', { nullable: true });
      if ((value.revision === 1) !== (value.priorEventSha256 === null)) fail('Only revision 1 may have no prior event.');
      digest(value.beforeEntriesSha256, 'authority transaction.beforeEntriesSha256');
      digest(value.afterEntriesSha256, 'authority transaction.afterEntriesSha256');
      identifier(value.actorId, 'authority transaction.actorId');
      if (value.authorization != null) {
        const authorization = validatePlatformRecord(
          value.authorization, 'platform-mutation-authorization'
        );
        if (authorization.actorId !== value.actorId) {
          fail('Authority transaction actor does not match its exact platform authorization.',
            'SGOS_PLATFORM_AUTHORIZATION_TAMPERED');
        }
      }
      timestamp(value.committedAt, 'authority transaction.committedAt');
      if (!Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 128) {
        fail('authority transaction.changes must contain 1..128 entries.');
      }
      let previous = null;
      for (const [index, change] of value.changes.entries()) {
        exactKeys(change, ['op', 'key', 'value'], `authority transaction.changes[${index}]`);
        requireKeys(change, change.op === 'put' ? ['op', 'key', 'value'] : ['op', 'key'], `authority transaction.changes[${index}]`);
        if (!['put', 'delete'].includes(change.op)) fail(`authority transaction.changes[${index}].op is invalid.`);
        identifier(change.key, `authority transaction.changes[${index}].key`);
        if (change.op === 'delete' && Object.hasOwn(change, 'value')) fail('Delete changes cannot carry a value.');
        if (previous !== null && previous >= change.key) fail('authority transaction changes must be sorted and unique by key.');
        previous = change.key;
      }
    }
  });
}

/** Exact approved-configuration witness for one private platform mutation. */
export function createPlatformMutationAuthorization(input) {
  return createRecord('platform-mutation-authorization', input, {
    allowed: [
      'operation', 'authorityGroup', 'actorId', 'identityAssurance', 'configurationKind',
      'configurationRef', 'configurationCommit', 'workflowSha256', 'authoritySha256',
      'authorizedAt'
    ],
    required: [
      'operation', 'authorityGroup', 'actorId', 'identityAssurance', 'configurationKind',
      'configurationRef', 'configurationCommit', 'workflowSha256', 'authoritySha256',
      'authorizedAt'
    ],
    validate(value) {
      identifier(value.operation, 'platform mutation authorization.operation');
      identifier(value.authorityGroup, 'platform mutation authorization.authorityGroup');
      identifier(value.actorId, 'platform mutation authorization.actorId');
      if (!['configured-local', 'github-authenticated'].includes(value.identityAssurance)) {
        fail('platform mutation authorization.identityAssurance is invalid.');
      }
      if (!['approved-configuration-ref', 'verified-state-mirror'].includes(value.configurationKind)) {
        fail('platform mutation authorization.configurationKind is invalid.');
      }
      string(value.configurationRef, 'platform mutation authorization.configurationRef');
      string(value.configurationCommit, 'platform mutation authorization.configurationCommit', /^[a-f0-9]{40,64}$/);
      digest(value.workflowSha256, 'platform mutation authorization.workflowSha256');
      digest(value.authoritySha256, 'platform mutation authorization.authoritySha256');
      timestamp(value.authorizedAt, 'platform mutation authorization.authorizedAt');
    }
  });
}

export function createAuthorityPortableExport(input) {
  return createRecord('platform-authority-export', input, {
    allowed: ['storeId', 'head', 'events', 'exportedAt'],
    required: ['storeId', 'head', 'events', 'exportedAt'],
    validate(value) {
      identifier(value.storeId, 'authority export.storeId');
      validatePlatformRecord(value.head, 'platform-authority-state');
      if (value.head.storeId !== value.storeId) fail('Authority export head belongs to another store.');
      if (!Array.isArray(value.events) || value.events.length !== value.head.revision) {
        fail('Authority export must contain exactly one event per committed revision.');
      }
      let priorEventSha256 = null;
      for (const [index, event] of value.events.entries()) {
        validatePlatformRecord(event, 'platform-authority-transaction');
        if (event.storeId !== value.storeId || event.revision !== index + 1
            || event.priorEventSha256 !== priorEventSha256) {
          fail('Authority export event lineage is invalid.');
        }
        priorEventSha256 = event.recordSha256;
      }
      if (priorEventSha256 !== value.head.eventSha256) fail('Authority export events do not reach the exported head.');
      timestamp(value.exportedAt, 'authority export.exportedAt');
    }
  });
}

export function createMemoryRef(input) {
  return createRecord('platform-memory-ref', input, {
    allowed: [
      'memoryId', 'version', 'class', 'scope', 'contentSha256', 'authorityStoreId',
      'sensitivity', 'dependencies', 'createdAt'
    ],
    required: [
      'memoryId', 'version', 'class', 'scope', 'contentSha256', 'authorityStoreId',
      'sensitivity', 'dependencies', 'createdAt'
    ],
    validate(value) {
      identifier(value.memoryId, 'memory ref.memoryId');
      integer(value.version, 'memory ref.version', 1);
      if (!MEMORY_CLASSES.includes(value.class)) fail(`memory ref.class must be one of: ${MEMORY_CLASSES.join(', ')}.`);
      identifier(value.scope, 'memory ref.scope');
      digest(value.contentSha256, 'memory ref.contentSha256');
      identifier(value.authorityStoreId, 'memory ref.authorityStoreId');
      if (!MEMORY_SENSITIVITY.includes(value.sensitivity)) fail('memory ref.sensitivity is invalid.');
      if (!Array.isArray(value.dependencies) || value.dependencies.length > 256) fail('memory ref.dependencies must be a bounded array.');
      let prior = null;
      for (const [index, dependency] of value.dependencies.entries()) {
        exactKeys(dependency, ['memoryId', 'version', 'refSha256'], `memory ref.dependencies[${index}]`);
        requireKeys(dependency, ['memoryId', 'version', 'refSha256'], `memory ref.dependencies[${index}]`);
        identifier(dependency.memoryId, `memory ref.dependencies[${index}].memoryId`);
        integer(dependency.version, `memory ref.dependencies[${index}].version`, 1);
        digest(dependency.refSha256, `memory ref.dependencies[${index}].refSha256`);
        if (prior !== null && prior >= dependency.memoryId) fail('memory ref.dependencies must be sorted and unique by memoryId.');
        prior = dependency.memoryId;
      }
      timestamp(value.createdAt, 'memory ref.createdAt');
    }
  });
}

export function createMemoryCandidate(input) {
  return createRecord('platform-memory-candidate', input, {
    allowed: ['candidateId', 'proposedRef', 'sourceRefs', 'evidenceRefs', 'proposerId', 'createdAt'],
    required: ['candidateId', 'proposedRef', 'sourceRefs', 'evidenceRefs', 'proposerId', 'createdAt'],
    validate(value) {
      identifier(value.candidateId, 'memory candidate.candidateId');
      validatePlatformRecord(value.proposedRef, 'platform-memory-ref');
      sortedUniqueStrings(value.sourceRefs, 'memory candidate.sourceRefs', { digests: true });
      sortedUniqueStrings(value.evidenceRefs, 'memory candidate.evidenceRefs', { digests: true });
      if (!value.sourceRefs.length || !value.evidenceRefs.length) fail('Memory candidates require source and evidence references.');
      identifier(value.proposerId, 'memory candidate.proposerId');
      timestamp(value.createdAt, 'memory candidate.createdAt');
    }
  });
}

export function createMemoryPromotion(input) {
  return createRecord('platform-memory-promotion', input, {
    allowed: ['candidateSha256', 'memoryRefSha256', 'reviewerId', 'decision', 'reason', 'promotedAt'],
    required: ['candidateSha256', 'memoryRefSha256', 'reviewerId', 'decision', 'reason', 'promotedAt'],
    validate(value) {
      digest(value.candidateSha256, 'memory promotion.candidateSha256');
      digest(value.memoryRefSha256, 'memory promotion.memoryRefSha256');
      identifier(value.reviewerId, 'memory promotion.reviewerId');
      if (value.decision !== 'approved') fail("Memory promotion decision must be 'approved'.");
      string(value.reason, 'memory promotion.reason');
      timestamp(value.promotedAt, 'memory promotion.promotedAt');
    }
  });
}

export function createSecretBrokerAttestation(input) {
  return createRecord('platform-secret-broker-attestation', input, {
    allowed: ['brokerId', 'purposes', 'audiences', 'validFrom', 'expiresAt', 'issuerKeyId'],
    required: ['brokerId', 'purposes', 'audiences', 'validFrom', 'expiresAt', 'issuerKeyId'],
    validate(value) {
      identifier(value.brokerId, 'secret broker.brokerId');
      sortedUniqueStrings(value.purposes, 'secret broker.purposes');
      sortedUniqueStrings(value.audiences, 'secret broker.audiences');
      if (!value.purposes.length || !value.audiences.length) fail('Secret broker purposes and audiences cannot be empty.');
      timestamp(value.validFrom, 'secret broker.validFrom');
      timestamp(value.expiresAt, 'secret broker.expiresAt');
      if (Date.parse(value.expiresAt) <= Date.parse(value.validFrom)) fail('Secret broker expiry must follow validFrom.');
      identifier(value.issuerKeyId, 'secret broker.issuerKeyId');
    }
  });
}

export function createSecretHandle(input) {
  return createRecord('platform-secret-handle', input, {
    allowed: [
      'handleId', 'brokerId', 'brokerAttestationSha256', 'opaqueReferenceSha256',
      'purpose', 'audience', 'expiresAt', 'attestedAt'
    ],
    required: [
      'handleId', 'brokerId', 'brokerAttestationSha256', 'opaqueReferenceSha256',
      'purpose', 'audience', 'expiresAt', 'attestedAt'
    ],
    validate(value) {
      identifier(value.handleId, 'secret handle.handleId');
      identifier(value.brokerId, 'secret handle.brokerId');
      digest(value.brokerAttestationSha256, 'secret handle.brokerAttestationSha256');
      digest(value.opaqueReferenceSha256, 'secret handle.opaqueReferenceSha256');
      identifier(value.purpose, 'secret handle.purpose');
      identifier(value.audience, 'secret handle.audience');
      timestamp(value.expiresAt, 'secret handle.expiresAt');
      timestamp(value.attestedAt, 'secret handle.attestedAt');
      if (Date.parse(value.expiresAt) <= Date.parse(value.attestedAt)) fail('Secret handle must expire after attestation.');
    }
  });
}

function canonicalPackPath(value, label) {
  string(value, label);
  if (value.startsWith('/') || value.startsWith('./') || value.includes('\\') || value.endsWith('/')
      || value.split('/').some((part) => !part || part === '.' || part === '..')) fail(`${label} must be a canonical relative path.`);
}

export function createCapabilityPack(input) {
  return createRecord('platform-capability-pack', input, {
    allowed: [
      'packId', 'version', 'domain', 'operations', 'permissions', 'files', 'lessons',
      'provenanceSha256', 'sbomSha256', 'publisherKeyId', 'createdAt'
    ],
    required: [
      'packId', 'version', 'domain', 'operations', 'permissions', 'files', 'lessons',
      'provenanceSha256', 'sbomSha256', 'publisherKeyId', 'createdAt'
    ],
    validate(value) {
      identifier(value.packId, 'capability pack.packId');
      string(value.version, 'capability pack.version', /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
      identifier(value.domain, 'capability pack.domain');
      sortedUniqueStrings(value.operations, 'capability pack.operations');
      sortedUniqueStrings(value.permissions, 'capability pack.permissions');
      if (!Array.isArray(value.files) || value.files.length > 4096) fail('capability pack.files must be a bounded array.');
      let priorPath = null;
      for (const [index, file] of value.files.entries()) {
        exactKeys(file, ['path', 'type', 'mode', 'contentSha256', 'bytes'], `capability pack.files[${index}]`);
        requireKeys(file, ['path', 'type', 'mode', 'contentSha256', 'bytes'], `capability pack.files[${index}]`);
        canonicalPackPath(file.path, `capability pack.files[${index}].path`);
        if (file.type !== 'file') fail('Bounded local capability packs may contain regular files only.');
        if (!['100644', '100755'].includes(file.mode)) fail('Capability pack file mode is invalid.');
        digest(file.contentSha256, `capability pack.files[${index}].contentSha256`);
        integer(file.bytes, `capability pack.files[${index}].bytes`);
        if (file.bytes > 8 * 1024 * 1024) fail('Capability pack file exceeds the local byte ceiling.');
        if (priorPath !== null && priorPath >= file.path) fail('Capability pack files must be sorted and unique by path.');
        priorPath = file.path;
      }
      if (!Array.isArray(value.lessons) || value.lessons.length > 256) fail('capability pack.lessons must be a bounded array.');
      let priorLesson = null;
      for (const [index, lesson] of value.lessons.entries()) {
        exactKeys(lesson, ['lessonId', 'roles', 'title', 'contentSha256'], `capability pack.lessons[${index}]`);
        requireKeys(lesson, ['lessonId', 'roles', 'title', 'contentSha256'], `capability pack.lessons[${index}]`);
        identifier(lesson.lessonId, `capability pack.lessons[${index}].lessonId`);
        sortedUniqueStrings(lesson.roles, `capability pack.lessons[${index}].roles`);
        string(lesson.title, `capability pack.lessons[${index}].title`);
        digest(lesson.contentSha256, `capability pack.lessons[${index}].contentSha256`);
        if (priorLesson !== null && priorLesson >= lesson.lessonId) fail('Capability pack lessons must be sorted and unique by ID.');
        priorLesson = lesson.lessonId;
      }
      digest(value.provenanceSha256, 'capability pack.provenanceSha256');
      digest(value.sbomSha256, 'capability pack.sbomSha256');
      identifier(value.publisherKeyId, 'capability pack.publisherKeyId');
      timestamp(value.createdAt, 'capability pack.createdAt');
    }
  });
}

export function createPackReview(input) {
  return createRecord('platform-pack-review', input, {
    allowed: ['packSha256', 'reviewerId', 'decision', 'reason', 'reviewedAt'],
    required: ['packSha256', 'reviewerId', 'decision', 'reason', 'reviewedAt'],
    validate(value) {
      digest(value.packSha256, 'pack review.packSha256');
      identifier(value.reviewerId, 'pack review.reviewerId');
      if (!['approved', 'rejected'].includes(value.decision)) fail('Pack review decision is invalid.');
      string(value.reason, 'pack review.reason');
      timestamp(value.reviewedAt, 'pack review.reviewedAt');
    }
  });
}

export function createPackActivation(input) {
  return createRecord('platform-pack-activation', input, {
    allowed: ['domain', 'packSha256', 'reviewSha256', 'activatedBy', 'activatedAt'],
    required: ['domain', 'packSha256', 'reviewSha256', 'activatedBy', 'activatedAt'],
    validate(value) {
      identifier(value.domain, 'pack activation.domain');
      digest(value.packSha256, 'pack activation.packSha256');
      digest(value.reviewSha256, 'pack activation.reviewSha256');
      identifier(value.activatedBy, 'pack activation.activatedBy');
      timestamp(value.activatedAt, 'pack activation.activatedAt');
    }
  });
}

export function createPackRevocation(input) {
  return createRecord('platform-pack-revocation', input, {
    allowed: ['packSha256', 'revokedBy', 'reason', 'revokedAt'],
    required: ['packSha256', 'revokedBy', 'reason', 'revokedAt'],
    validate(value) {
      digest(value.packSha256, 'pack revocation.packSha256');
      identifier(value.revokedBy, 'pack revocation.revokedBy');
      string(value.reason, 'pack revocation.reason');
      timestamp(value.revokedAt, 'pack revocation.revokedAt');
    }
  });
}

export function createAcceptedTrace(input) {
  return createRecord('platform-accepted-trace', input, {
    allowed: [
      'traceSha256', 'evidenceSha256', 'verificationReceiptSha256',
      'outcomeAcceptanceSha256', 'containsSecrets', 'unresolvedGaps',
      'issuerKeyId', 'acceptedAt'
    ],
    required: [
      'traceSha256', 'evidenceSha256', 'verificationReceiptSha256',
      'outcomeAcceptanceSha256', 'containsSecrets', 'unresolvedGaps',
      'issuerKeyId', 'acceptedAt'
    ],
    validate(value) {
      digest(value.traceSha256, 'accepted trace.traceSha256');
      digest(value.evidenceSha256, 'accepted trace.evidenceSha256');
      digest(value.verificationReceiptSha256, 'accepted trace.verificationReceiptSha256');
      digest(value.outcomeAcceptanceSha256, 'accepted trace.outcomeAcceptanceSha256');
      if (value.containsSecrets !== false) fail('Accepted meta-tool traces must explicitly contain no secrets.');
      if (value.unresolvedGaps !== 0) fail('Accepted meta-tool traces must have zero unresolved gaps.');
      identifier(value.issuerKeyId, 'accepted trace.issuerKeyId');
      timestamp(value.acceptedAt, 'accepted trace.acceptedAt');
    }
  });
}

export function createMetaToolCandidate(input) {
  return createRecord('platform-meta-tool-candidate', input, {
    allowed: ['candidateId', 'operationId', 'traceRefs', 'proposerId', 'createdAt'],
    required: ['candidateId', 'operationId', 'traceRefs', 'proposerId', 'createdAt'],
    validate(value) {
      identifier(value.candidateId, 'meta-tool candidate.candidateId');
      identifier(value.operationId, 'meta-tool candidate.operationId');
      sortedUniqueStrings(value.traceRefs, 'meta-tool candidate.traceRefs', { digests: true });
      if (value.traceRefs.length < 2) fail('Meta-tool candidates require at least two accepted trace references.');
      if (value.traceRefs.length > 256) fail('Meta-tool candidates accept at most 256 trace references.');
      identifier(value.proposerId, 'meta-tool candidate.proposerId');
      timestamp(value.createdAt, 'meta-tool candidate.createdAt');
    }
  });
}

export function createMetaToolEvaluation(input) {
  return createRecord('platform-meta-tool-evaluation', input, {
    allowed: [
      'candidateSha256', 'securityGate', 'qualityGate', 'costGate', 'holdoutSha256',
      'evaluatorKeyId', 'evaluatedAt'
    ],
    required: [
      'candidateSha256', 'securityGate', 'qualityGate', 'costGate', 'holdoutSha256',
      'evaluatorKeyId', 'evaluatedAt'
    ],
    validate(value) {
      digest(value.candidateSha256, 'meta-tool evaluation.candidateSha256');
      for (const gate of ['securityGate', 'qualityGate', 'costGate']) {
        if (!['passed', 'failed', 'inconclusive'].includes(value[gate])) fail(`meta-tool evaluation.${gate} is invalid.`);
      }
      digest(value.holdoutSha256, 'meta-tool evaluation.holdoutSha256');
      identifier(value.evaluatorKeyId, 'meta-tool evaluation.evaluatorKeyId');
      timestamp(value.evaluatedAt, 'meta-tool evaluation.evaluatedAt');
    }
  });
}

export function createMetaToolPromotion(input) {
  return createRecord('platform-meta-tool-promotion', input, {
    allowed: [
      'candidateSha256', 'evaluationSha256', 'reviewerId', 'decision', 'reason',
      'status', 'promotedAt'
    ],
    required: [
      'candidateSha256', 'evaluationSha256', 'reviewerId', 'decision', 'reason',
      'status', 'promotedAt'
    ],
    validate(value) {
      digest(value.candidateSha256, 'meta-tool promotion.candidateSha256');
      digest(value.evaluationSha256, 'meta-tool promotion.evaluationSha256');
      identifier(value.reviewerId, 'meta-tool promotion.reviewerId');
      if (value.decision !== 'approved') fail("Meta-tool promotion decision must be 'approved'.");
      string(value.reason, 'meta-tool promotion.reason');
      if (value.reason.length > 2048) fail('meta-tool promotion.reason exceeds 2048 characters.');
      if (value.status !== 'pack-review-required') fail("Bounded local promotion status must be 'pack-review-required'.");
      timestamp(value.promotedAt, 'meta-tool promotion.promotedAt');
    }
  });
}

const META_TOOL_TARGET_KINDS = Object.freeze(['device-operation', 'pack-operation']);
const META_TOOL_OUTCOMES = Object.freeze(['degraded', 'failed', 'succeeded']);

function validateMetaToolTarget(value, label = 'meta-tool target') {
  exactKeys(value, [
    'kind', 'operationId', 'version', 'manifestSha256', 'authoritySha256',
    'approvalSha256', 'targetSha256'
  ], label);
  requireKeys(value, [
    'kind', 'operationId', 'version', 'manifestSha256', 'authoritySha256',
    'approvalSha256', 'targetSha256'
  ], label);
  if (!META_TOOL_TARGET_KINDS.includes(value.kind)) fail(`${label}.kind is invalid.`);
  identifier(value.operationId, `${label}.operationId`);
  string(value.version, `${label}.version`, /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/);
  digest(value.manifestSha256, `${label}.manifestSha256`);
  digest(value.authoritySha256, `${label}.authoritySha256`);
  digest(value.approvalSha256, `${label}.approvalSha256`);
  digest(value.targetSha256, `${label}.targetSha256`);
  const core = clonePlatformJson(value);
  delete core.targetSha256;
  if (platformSha256(core) !== value.targetSha256) fail(`${label}.targetSha256 is not canonical.`);
}

function validateMetaToolObservationPolicy(value, label = 'meta-tool observation policy') {
  exactKeys(value, [
    'maximumObservations', 'maximumEvidenceRefs', 'acceptedOutcomes', 'policySha256'
  ], label);
  requireKeys(value, [
    'maximumObservations', 'maximumEvidenceRefs', 'acceptedOutcomes', 'policySha256'
  ], label);
  integer(value.maximumObservations, `${label}.maximumObservations`, 1);
  if (value.maximumObservations > 10_000) fail(`${label}.maximumObservations exceeds 10000.`);
  integer(value.maximumEvidenceRefs, `${label}.maximumEvidenceRefs`, 1);
  if (value.maximumEvidenceRefs > 64) fail(`${label}.maximumEvidenceRefs exceeds 64.`);
  sortedUniqueStrings(value.acceptedOutcomes, `${label}.acceptedOutcomes`);
  if (!value.acceptedOutcomes.length
      || value.acceptedOutcomes.some((outcome) => !META_TOOL_OUTCOMES.includes(outcome))) {
    fail(`${label}.acceptedOutcomes must be a non-empty subset of degraded, failed, and succeeded.`);
  }
  digest(value.policySha256, `${label}.policySha256`);
  const core = clonePlatformJson(value);
  delete core.policySha256;
  if (platformSha256(core) !== value.policySha256) fail(`${label}.policySha256 is not canonical.`);
}

export function createMetaToolTarget(input) {
  const core = clonePlatformJson(input);
  delete core.targetSha256;
  const target = { ...core, targetSha256: platformSha256(core) };
  validateMetaToolTarget(target);
  return freezeDeep(target);
}

export function createMetaToolObservationPolicy(input) {
  const core = clonePlatformJson(input);
  delete core.policySha256;
  const policy = { ...core, policySha256: platformSha256(core) };
  validateMetaToolObservationPolicy(policy);
  return freezeDeep(policy);
}

export function createMetaToolActivation(input) {
  return createRecord('platform-meta-tool-activation', input, {
    allowed: [
      'candidateSha256', 'evaluationSha256', 'promotionSha256', 'target',
      'observationPolicy', 'supersedesActivationSha256', 'activatedRevision',
      'activatedBy', 'activatedAt'
    ],
    required: [
      'candidateSha256', 'evaluationSha256', 'promotionSha256', 'target',
      'observationPolicy', 'supersedesActivationSha256', 'activatedRevision',
      'activatedBy', 'activatedAt'
    ],
    validate(value) {
      digest(value.candidateSha256, 'meta-tool activation.candidateSha256');
      digest(value.evaluationSha256, 'meta-tool activation.evaluationSha256');
      digest(value.promotionSha256, 'meta-tool activation.promotionSha256');
      validateMetaToolTarget(value.target, 'meta-tool activation.target');
      validateMetaToolObservationPolicy(value.observationPolicy,
        'meta-tool activation.observationPolicy');
      digest(value.supersedesActivationSha256,
        'meta-tool activation.supersedesActivationSha256', { nullable: true });
      integer(value.activatedRevision, 'meta-tool activation.activatedRevision', 1);
      identifier(value.activatedBy, 'meta-tool activation.activatedBy');
      timestamp(value.activatedAt, 'meta-tool activation.activatedAt');
    }
  });
}

export function createMetaToolObservation(input) {
  return createRecord('platform-meta-tool-observation', input, {
    allowed: [
      'activationSha256', 'sequence', 'outcome', 'evidenceRefs', 'observedBy', 'observedAt'
    ],
    required: [
      'activationSha256', 'sequence', 'outcome', 'evidenceRefs', 'observedBy', 'observedAt'
    ],
    validate(value) {
      digest(value.activationSha256, 'meta-tool observation.activationSha256');
      integer(value.sequence, 'meta-tool observation.sequence', 1);
      if (!META_TOOL_OUTCOMES.includes(value.outcome)) fail('meta-tool observation.outcome is invalid.');
      sortedUniqueStrings(value.evidenceRefs, 'meta-tool observation.evidenceRefs', { digests: true });
      if (!value.evidenceRefs.length || value.evidenceRefs.length > 64) {
        fail('meta-tool observation.evidenceRefs must contain 1..64 exact evidence digests.');
      }
      identifier(value.observedBy, 'meta-tool observation.observedBy');
      timestamp(value.observedAt, 'meta-tool observation.observedAt');
    }
  });
}

export function createMetaToolRevocation(input) {
  return createRecord('platform-meta-tool-revocation', input, {
    allowed: ['activationSha256', 'revokedBy', 'reason', 'revokedAt'],
    required: ['activationSha256', 'revokedBy', 'reason', 'revokedAt'],
    validate(value) {
      digest(value.activationSha256, 'meta-tool revocation.activationSha256');
      identifier(value.revokedBy, 'meta-tool revocation.revokedBy');
      string(value.reason, 'meta-tool revocation.reason');
      if (value.reason.length > 2048) fail('meta-tool revocation.reason exceeds 2048 characters.');
      timestamp(value.revokedAt, 'meta-tool revocation.revokedAt');
    }
  });
}

export function createMetaToolRollback(input) {
  return createRecord('platform-meta-tool-rollback', input, {
    allowed: [
      'operationId', 'fromActivationSha256', 'toActivationSha256',
      'rolledBackBy', 'reason', 'rolledBackAt'
    ],
    required: [
      'operationId', 'fromActivationSha256', 'toActivationSha256',
      'rolledBackBy', 'reason', 'rolledBackAt'
    ],
    validate(value) {
      identifier(value.operationId, 'meta-tool rollback.operationId');
      digest(value.fromActivationSha256, 'meta-tool rollback.fromActivationSha256');
      digest(value.toActivationSha256, 'meta-tool rollback.toActivationSha256');
      if (value.fromActivationSha256 === value.toActivationSha256) {
        fail('Meta-tool rollback must select a different prior activation.');
      }
      identifier(value.rolledBackBy, 'meta-tool rollback.rolledBackBy');
      string(value.reason, 'meta-tool rollback.reason');
      if (value.reason.length > 2048) fail('meta-tool rollback.reason exceeds 2048 characters.');
      timestamp(value.rolledBackAt, 'meta-tool rollback.rolledBackAt');
    }
  });
}

export const platformContractInternals = Object.freeze({
  exactKeys, requireKeys, string, digest, integer, timestamp, identifier,
  sortedUniqueStrings, freezeDeep
});
