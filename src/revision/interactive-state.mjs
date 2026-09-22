/**
 * Machine-private pointer for the interactive REV hand-off.
 *
 * Immutable evidence stays in the REV record store and loop journal. This small pointer only lets
 * another CLI/Copilot/VS Code process find the current packet and the optional precheck inputs after
 * reload. It is self-hashed, bounded, stored below the Git common directory, and carries no raw
 * feedback, source bytes, prompt, or provider output.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import {
  readPrivateSidecar, writeImmutablePrivateSidecar, writeMutablePrivateSidecar
} from '../private-sidecar.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { scanText } from '../secrets.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_STATE_BYTES = 96 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_CONFIRMATION_RESULT_BYTES = 128 * 1024;
const STATES = new Set([
  'opening', 'awaiting-edit', 'capturing', 'candidate-frozen', 'prechecked',
  'abandoning', 'abandoned', 'recovery-required'
]);
const AUTHOR_KINDS = new Set(['configured-local', 'authenticated-user', 'service']);
const CRITERIA_MODES = new Set([
  'explicit', 'exact-id', 'exact-phrase', 'structural-reference', 'unscoped', 'ambiguous'
]);
const DISPOSITIONS = new Set([
  'implementation-change', 'specification-change', 'ambiguous', 'unrelated'
]);

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function digest(value) { return `sha256:${recordSha256(value)}`; }
function id(value, label) {
  if (!ID.test(String(value ?? ''))) fail('REV_INTERACTIVE_STATE_INVALID', `${label} is invalid.`);
  return value;
}
function sha(value, label) {
  if (!HASH.test(String(value ?? ''))) fail('REV_INTERACTIVE_STATE_INVALID', `${label} is invalid.`);
  return value;
}
function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function boundedString(value, maximum) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}
function validStartAuthor(value) {
  return exactObject(value, ['kind', 'id', 'name'])
    && AUTHOR_KINDS.has(value.kind)
    && boundedString(value.id, 256)
    && boundedString(value.name, 256);
}
function validStartCriterion(value) {
  return exactObject(value, ['id', 'clauseSha256'])
    && boundedString(value.id, 128)
    && HASH.test(String(value.clauseSha256 ?? ''));
}
function validStartCriteria(value) {
  return exactObject(value, ['mode', 'bound', 'packet'])
    && CRITERIA_MODES.has(value.mode)
    && Array.isArray(value.bound) && value.bound.length <= 128
    && value.bound.every(validStartCriterion)
    && Array.isArray(value.packet) && value.packet.length <= 128
    && value.packet.every(validStartCriterion);
}
function validStartDisposition(value) {
  return exactObject(value, ['result', 'predicateId', 'human'])
    && DISPOSITIONS.has(value.result)
    && boundedString(value.predicateId, 128)
    && typeof value.human === 'boolean';
}
function validStartProducer(value) {
  return exactObject(value, ['id', 'version', 'implementationSha256'])
    && ID.test(String(value.id ?? ''))
    && boundedString(value.version, 64)
    && HASH.test(String(value.implementationSha256 ?? ''));
}
function subject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== ['phaseGeneration', 'phaseId', 'workId'].sort().join('\0')
      || !Number.isSafeInteger(value.phaseGeneration) || value.phaseGeneration < 0) {
    fail('REV_INTERACTIVE_STATE_INVALID', 'Interactive REV subject is invalid.');
  }
  return {
    workId: id(value.workId, 'workId'), phaseId: id(value.phaseId, 'phaseId'),
    phaseGeneration: value.phaseGeneration
  };
}
function scopeKey(value) {
  return createHash('sha256').update(canonicalJson(subject(value))).digest('hex');
}
function directory(root, selected) {
  return path.join(path.resolve(gitCommonDir(root)), 'singularity-flow', 'revisions',
    scopeKey(selected), 'interactive');
}
function statePath(root, selected) { return path.join(directory(root, selected), 'state.json'); }
function payloadPath(root, selected, payloadSha256) {
  return path.join(directory(root, selected), 'payloads', `${sha(payloadSha256, 'payload digest').slice(7)}.json`);
}
function startPinPath(root, selected, startPlanSha256) {
  return path.join(directory(root, selected), 'confirmations',
    `${sha(startPlanSha256, 'start plan digest').slice(7)}.json`);
}
function confirmationResultPath(root, selected, startPlanSha256) {
  return path.join(directory(root, selected), 'confirmation-results',
    `${sha(startPlanSha256, 'start plan digest').slice(7)}.json`);
}
function confirmationRecoveryPath(root, selected, startPlanSha256) {
  return path.join(directory(root, selected), 'confirmation-recovery',
    `${sha(startPlanSha256, 'start plan digest').slice(7)}.json`);
}
function seal(core) { return Object.freeze({ ...core, stateSha256: digest(core) }); }
function validateState(raw, expectedSubject = null) {
  const keys = [
    'schemaVersion', 'kind', 'subject', 'status', 'loopId', 'loopRevision',
    'startPlanSha256', 'startPlanPayloadSha256', 'startPinSha256', 'contextSha256',
    'feedbackRecordSha256', 'criteriaBindingSha256', 'dispositionSha256', 'packetSha256',
    'routePlanSha256', 'parentCandidateId', 'resultCandidateId', 'capturePlanSha256',
    'capturePayloadSha256', 'captureEffectSetSha256', 'recoveryCode',
    'captureStartedAt', 'captureEndedAt', 'abandonPlanSha256', 'abandonPayloadSha256',
    'precheckSha256', 'precheckInputSha256',
    'createdAt', 'updatedAt', 'stateSha256'
  ];
  let selected;
  try { selected = readRecord('revision-interactive-state', raw).record; }
  catch { fail('REV_INTERACTIVE_STATE_INVALID', 'Interactive REV state has an unknown shape.'); }
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)
      || Object.keys(selected).sort().join('\0') !== keys.sort().join('\0')
      || selected.kind !== 'revision-interactive-state'
      || !STATES.has(selected.status)) {
    fail('REV_INTERACTIVE_STATE_INVALID', 'Interactive REV state has an unknown shape.');
  }
  const selectedSubject = subject(selected.subject);
  if (expectedSubject && digest(selectedSubject) !== digest(subject(expectedSubject))) {
    fail('REV_INTERACTIVE_STATE_SCOPE', 'Interactive REV state belongs to another Story phase.');
  }
  id(selected.loopId, 'loopId');
  if (!Number.isSafeInteger(selected.loopRevision) || selected.loopRevision < -1) {
    fail('REV_INTERACTIVE_STATE_INVALID', 'Interactive REV loop revision is invalid.');
  }
  for (const field of [
    'startPlanSha256', 'startPlanPayloadSha256', 'startPinSha256', 'contextSha256',
    'feedbackRecordSha256', 'criteriaBindingSha256', 'dispositionSha256', 'packetSha256',
    'routePlanSha256'
  ]) sha(selected[field], field);
  for (const field of [
    'capturePlanSha256', 'capturePayloadSha256', 'captureEffectSetSha256',
    'abandonPlanSha256', 'abandonPayloadSha256', 'precheckSha256', 'precheckInputSha256'
  ]) {
    if (selected[field] !== null) sha(selected[field], field);
  }
  if (selected.recoveryCode !== null
      && !/^[A-Z][A-Z0-9_]{1,127}$/u.test(String(selected.recoveryCode))) {
    fail('REV_INTERACTIVE_STATE_INVALID', 'recoveryCode is invalid.');
  }
  for (const field of ['captureStartedAt', 'captureEndedAt']) {
    if (selected[field] !== null && (typeof selected[field] !== 'string'
        || Number.isNaN(Date.parse(selected[field]))
        || new Date(selected[field]).toISOString() !== selected[field])) {
      fail('REV_INTERACTIVE_STATE_INVALID', `${field} is invalid.`);
    }
  }
  for (const field of ['parentCandidateId', 'resultCandidateId']) {
    if (selected[field] !== null && !/^CAN-[A-Za-z0-9._:-]{6,127}$/u.test(selected[field])) {
      fail('REV_INTERACTIVE_STATE_INVALID', `${field} is invalid.`);
    }
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof selected[field] !== 'string' || Number.isNaN(Date.parse(selected[field]))
        || new Date(selected[field]).toISOString() !== selected[field]) {
      fail('REV_INTERACTIVE_STATE_INVALID', `${field} is invalid.`);
    }
  }
  if (['capturing', 'candidate-frozen', 'prechecked'].includes(selected.status)
      && (selected.capturePlanSha256 === null || selected.capturePayloadSha256 === null)) {
    fail('REV_INTERACTIVE_STATE_INVALID',
      'An in-flight or completed capture must bind its exact plan and private authority payload.');
  }
  if (['candidate-frozen', 'prechecked'].includes(selected.status)
      && (selected.resultCandidateId === null || selected.captureEffectSetSha256 === null)) {
    fail('REV_INTERACTIVE_STATE_INVALID',
      'A frozen capture must bind its retained Candidate and exact effect set.');
  }
  if (selected.status === 'recovery-required' && selected.recoveryCode === null) {
    fail('REV_INTERACTIVE_STATE_INVALID', 'Recovery-required state needs a stable reason code.');
  }
  if (['abandoning', 'abandoned'].includes(selected.status)
      && (selected.abandonPlanSha256 === null || selected.abandonPayloadSha256 === null)) {
    fail('REV_INTERACTIVE_STATE_INVALID',
      'An in-flight or completed abandonment must bind its exact plan and private authority payload.');
  }
  const { stateSha256, ...core } = selected;
  if (sha(stateSha256, 'stateSha256') !== digest(core)) {
    fail('REV_INTERACTIVE_STATE_CORRUPT', 'Interactive REV state failed its content hash.');
  }
  return Object.freeze(structuredClone(selected));
}

export async function readRevisionInteractiveState(root, selected, { optional = true } = {}) {
  const bytes = await readPrivateSidecar(root, statePath(root, selected), {
    maximumBytes: MAX_STATE_BYTES, optional, enforceWindowsAcl: true
  });
  if (bytes == null) return null;
  let parsed;
  try { parsed = JSON.parse(bytes); }
  catch { fail('REV_INTERACTIVE_STATE_CORRUPT', 'Interactive REV state is not valid JSON.'); }
  return validateState(parsed, selected);
}

export async function writeRevisionInteractiveState(root, value, {
  expectedStateSha256 = undefined
} = {}) {
  const selectedSubject = subject(value.subject);
  return withSubjectLock(root, { kind: 'story', id: selectedSubject.workId }, () =>
    withSubjectLock(root, {
      kind: 'revision-interactive-state',
      id: `${selectedSubject.workId}:${selectedSubject.phaseId}:${selectedSubject.phaseGeneration}`
    }, async () => {
    const current = await readRevisionInteractiveState(root, selectedSubject, { optional: true });
    if (expectedStateSha256 !== undefined
        && (current?.stateSha256 ?? null) !== expectedStateSha256) {
      fail('REV_INTERACTIVE_STATE_ADVANCED',
        'Interactive REV state changed after preview; inspect and retry from the current state.');
    }
    const createdAt = current?.createdAt ?? value.createdAt ?? new Date().toISOString();
    const core = {
      schemaVersion: currentSchemaVersion('revision-interactive-state'),
      kind: 'revision-interactive-state', subject: selectedSubject,
      status: value.status, loopId: value.loopId, loopRevision: value.loopRevision,
      startPlanSha256: value.startPlanSha256,
      startPlanPayloadSha256: value.startPlanPayloadSha256,
      startPinSha256: value.startPinSha256,
      contextSha256: value.contextSha256,
      feedbackRecordSha256: value.feedbackRecordSha256,
      criteriaBindingSha256: value.criteriaBindingSha256,
      dispositionSha256: value.dispositionSha256,
      packetSha256: value.packetSha256, routePlanSha256: value.routePlanSha256,
      parentCandidateId: value.parentCandidateId ?? null,
      resultCandidateId: value.resultCandidateId ?? null,
      capturePlanSha256: value.capturePlanSha256 ?? null,
      capturePayloadSha256: value.capturePayloadSha256 ?? null,
      captureEffectSetSha256: value.captureEffectSetSha256 ?? null,
      recoveryCode: value.recoveryCode ?? null,
      captureStartedAt: value.captureStartedAt ?? null,
      captureEndedAt: value.captureEndedAt ?? null,
      abandonPlanSha256: value.abandonPlanSha256 ?? null,
      abandonPayloadSha256: value.abandonPayloadSha256 ?? null,
      precheckSha256: value.precheckSha256 ?? null,
      precheckInputSha256: value.precheckInputSha256 ?? null,
      createdAt, updatedAt: value.updatedAt ?? new Date().toISOString()
    };
    const sealed = validateState(seal(core), selectedSubject);
    await writeMutablePrivateSidecar(root, statePath(root, selectedSubject), canonicalJson(sealed), {
      maximumBytes: MAX_STATE_BYTES, enforceWindowsAcl: true
    });
    return sealed;
    }));
}

export async function writeRevisionInteractivePayload(root, selected, payload) {
  let bytes;
  try { bytes = Buffer.from(canonicalJson(payload)); }
  catch { fail('REV_INTERACTIVE_PAYLOAD_INVALID', 'Interactive REV payload must be bounded JSON.'); }
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    fail('REV_INTERACTIVE_PAYLOAD_LIMIT', 'Interactive REV payload exceeds its installed byte limit.');
  }
  const payloadSha256 = digest(payload);
  await writeImmutablePrivateSidecar(root, payloadPath(root, selected, payloadSha256), bytes, {
    maximumBytes: MAX_PAYLOAD_BYTES, enforceWindowsAcl: true
  });
  return payloadSha256;
}

export async function readRevisionInteractivePayload(root, selected, payloadSha256) {
  const bytes = await readPrivateSidecar(root, payloadPath(root, selected, payloadSha256), {
    maximumBytes: MAX_PAYLOAD_BYTES, enforceWindowsAcl: true
  });
  let parsed;
  try { parsed = JSON.parse(bytes); }
  catch { fail('REV_INTERACTIVE_PAYLOAD_CORRUPT', 'Interactive REV payload is not valid JSON.'); }
  if (digest(parsed) !== payloadSha256) {
    fail('REV_INTERACTIVE_PAYLOAD_CORRUPT', 'Interactive REV payload failed its content digest.');
  }
  return Object.freeze(parsed);
}

function validateConfirmationResult(raw, selected, expectedPlanSha256) {
  const keys = [
    'schemaVersion', 'kind', 'subject', 'startPlanSha256', 'startPlanPayloadSha256',
    'startPinSha256', 'packetSha256', 'state', 'records', 'next', 'completedAt',
    'resultSha256'
  ];
  const selectedSubject = subject(selected);
  let migrated;
  try { migrated = readRecord('revision-interactive-confirmation-result', raw).record; }
  catch { fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision confirmation result has an unknown shape.'); }
  raw = migrated;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).sort().join('\0') !== keys.sort().join('\0')
      || raw.kind !== 'revision-interactive-confirmation-result'
      || digest(raw.subject) !== digest(selectedSubject)
      || raw.startPlanSha256 !== sha(expectedPlanSha256, 'startPlanSha256')) {
    fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision confirmation result has an unknown shape.');
  }
  sha(raw.startPlanPayloadSha256, 'startPlanPayloadSha256');
  sha(raw.startPinSha256, 'startPinSha256');
  sha(raw.packetSha256, 'packetSha256');
  const resultState = validateState(raw.state, selectedSubject);
  const expectedRecords = [
    { kind: 'revision-feedback', sha256: resultState.feedbackRecordSha256 },
    { kind: 'revision-criteria-binding', sha256: resultState.criteriaBindingSha256 },
    { kind: 'revision-specification-disposition', sha256: resultState.dispositionSha256 },
    { kind: 'revision-packet', sha256: resultState.packetSha256 }
  ];
  if (resultState.startPlanSha256 !== raw.startPlanSha256
      || resultState.startPlanPayloadSha256 !== raw.startPlanPayloadSha256
      || resultState.startPinSha256 !== raw.startPinSha256
      || resultState.packetSha256 !== raw.packetSha256
      || !Array.isArray(raw.records) || raw.records.length !== expectedRecords.length
      || raw.records.some((item) => !exactObject(item, ['kind', 'sha256'])
        || !boundedString(item.kind, 128) || !HASH.test(String(item.sha256 ?? '')))
      || digest(raw.records) !== digest(expectedRecords)
      || resultState.status !== 'awaiting-edit'
      || raw.next !== 'revision.capture'
      || typeof raw.completedAt !== 'string'
      || Number.isNaN(Date.parse(raw.completedAt))
      || new Date(raw.completedAt).toISOString() !== raw.completedAt
      || raw.completedAt !== resultState.updatedAt) {
    fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision confirmation result is invalid or stale.');
  }
  const { resultSha256, ...core } = raw;
  if (sha(resultSha256, 'resultSha256') !== digest(core)) {
    fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision confirmation result failed its content hash.');
  }
  return Object.freeze({ ...structuredClone(raw), state: resultState });
}

/**
 * Preserve the exact successful confirmation result under its plan digest. This is separate from
 * the mutable current-interval pointer so a later interval cannot erase idempotent replay.
 */
export async function writeRevisionInteractiveConfirmationResult(root, selected, value) {
  const selectedSubject = subject(selected);
  const resultState = validateState(value.state, selectedSubject);
  const core = {
    schemaVersion: currentSchemaVersion('revision-interactive-confirmation-result'),
    kind: 'revision-interactive-confirmation-result',
    subject: selectedSubject,
    startPlanSha256: sha(value.startPlanSha256, 'startPlanSha256'),
    startPlanPayloadSha256: sha(value.startPlanPayloadSha256, 'startPlanPayloadSha256'),
    startPinSha256: sha(value.startPinSha256, 'startPinSha256'),
    packetSha256: sha(value.packetSha256, 'packetSha256'),
    state: resultState,
    records: structuredClone(value.records ?? []),
    next: value.next,
    // The already-sealed state timestamp makes repeated writes byte-identical.
    completedAt: resultState.updatedAt
  };
  const result = validateConfirmationResult({ ...core, resultSha256: digest(core) },
    selectedSubject, core.startPlanSha256);
  const bytes = Buffer.from(canonicalJson(result));
  // Retain an independently addressed recovery copy before allowing a later interval to replace
  // the mutable pointer. A missing primary receipt can then be repaired by plan digest without
  // consulting whichever interval happens to be current.
  await writeImmutablePrivateSidecar(root,
    confirmationRecoveryPath(root, selectedSubject, core.startPlanSha256),
    bytes, { maximumBytes: MAX_CONFIRMATION_RESULT_BYTES, enforceWindowsAcl: true });
  await writeImmutablePrivateSidecar(root,
    confirmationResultPath(root, selectedSubject, core.startPlanSha256),
    bytes, { maximumBytes: MAX_CONFIRMATION_RESULT_BYTES, enforceWindowsAcl: true });
  return result;
}

export async function readRevisionInteractiveConfirmationResult(root, selected,
  startPlanSha256, { optional = true, recovery = false } = {}) {
  const selectedSubject = subject(selected);
  const bytes = await readPrivateSidecar(root,
    (recovery ? confirmationRecoveryPath : confirmationResultPath)(
      root, selectedSubject, startPlanSha256), {
      maximumBytes: MAX_CONFIRMATION_RESULT_BYTES, optional, enforceWindowsAcl: true
    });
  if (bytes == null) return null;
  let raw;
  try { raw = JSON.parse(bytes); }
  catch { fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision confirmation result is not valid JSON.'); }
  return validateConfirmationResult(raw, selectedSubject, startPlanSha256);
}

function validateStartPin(raw, selected, expected) {
  const keys = [
    'schemaVersion', 'kind', 'subject', 'startPlanSha256', 'feedbackSha256', 'feedbackText',
    'author', 'criteria', 'disposition', 'privacyPolicySha256', 'capturedAt', 'producer', 'pinSha256'
  ];
  let migrated;
  try { migrated = readRecord('revision-interactive-start-pin', raw).record; }
  catch { fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision start pin is not a readable registered record.'); }
  raw = migrated;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).sort().join('\0') !== keys.sort().join('\0')
      || raw.kind !== 'revision-interactive-start-pin'
      || digest(raw.subject) !== digest(subject(selected))
      || raw.startPlanSha256 !== sha(expected.startPlanSha256, 'startPlanSha256')
      || raw.feedbackSha256 !== sha(expected.feedbackSha256, 'feedbackSha256')
      || raw.feedbackText !== expected.feedbackText
      || Buffer.byteLength(raw.feedbackText) < 1 || Buffer.byteLength(raw.feedbackText) > 8192
      || `sha256:${createHash('sha256').update(raw.feedbackText).digest('hex')}` !== raw.feedbackSha256
      || scanText(raw.feedbackText).length > 0
      || !validStartAuthor(raw.author)
      || !validStartCriteria(raw.criteria)
      || !validStartDisposition(raw.disposition)
      || !validStartProducer(raw.producer)
      || digest(raw.author) !== digest(expected.author)
      || digest(raw.criteria) !== digest(expected.criteria)
      || digest(raw.disposition) !== digest(expected.disposition)
      || raw.privacyPolicySha256 !== sha(expected.privacyPolicySha256, 'privacyPolicySha256')
      || digest(raw.producer) !== digest(expected.producer)
      || typeof raw.capturedAt !== 'string'
      || Number.isNaN(Date.parse(raw.capturedAt))
      || new Date(raw.capturedAt).toISOString() !== raw.capturedAt) {
    fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision start pin is invalid or stale.');
  }
  const { pinSha256, ...core } = raw;
  if (sha(pinSha256, 'pinSha256') !== digest(core)) {
    fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision start pin failed its content hash.');
  }
  return Object.freeze(structuredClone(raw));
}

/** First confirmed write: pin exact private feedback and routing facts before any Candidate effect. */
export async function readOrCreateRevisionStartPin(root, selected, expected) {
  const selectedSubject = subject(selected);
  if (typeof expected?.feedbackText !== 'string' || !expected.feedbackText.trim()
      || Buffer.byteLength(expected.feedbackText) > 8192
      || expected.feedbackText.split(/\r?\n/u).length > 80
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(expected.feedbackText)
      || `sha256:${createHash('sha256').update(expected.feedbackText).digest('hex')}`
        !== expected.feedbackSha256) {
    fail('REV_FEEDBACK_INVALID', 'Revision start pin needs exact bounded feedback bytes.');
  }
  if (scanText(expected.feedbackText).length) {
    fail('REV_FEEDBACK_SECRET', 'Revision feedback may contain a credential; no durable REV effect was created.');
  }
  if (!validStartAuthor(expected.author)
      || !validStartCriteria(expected.criteria)
      || !validStartDisposition(expected.disposition)
      || !HASH.test(String(expected.privacyPolicySha256 ?? ''))
      || !validStartProducer(expected.producer)) {
    fail('REV_INTERACTIVE_STATE_INVALID',
      'Revision start pin lacks exact author, criteria, disposition, or producer.');
  }
  const target = startPinPath(root, selectedSubject, expected.startPlanSha256);
  return withSubjectLock(root, {
    kind: 'revision-start-pin',
    id: `${selectedSubject.workId}:${selectedSubject.phaseId}:${selectedSubject.phaseGeneration}`
  }, async () => {
    const existing = await readPrivateSidecar(root, target, {
      maximumBytes: 16 * 1024, optional: true, enforceWindowsAcl: true
    });
    if (existing != null) {
      try { return validateStartPin(JSON.parse(existing), selectedSubject, expected); }
      catch (error) {
        if (error instanceof SingularityFlowError) throw error;
        fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision start pin is not valid JSON.');
      }
    }
    const core = {
      schemaVersion: currentSchemaVersion('revision-interactive-start-pin'),
      kind: 'revision-interactive-start-pin', subject: selectedSubject,
      startPlanSha256: sha(expected.startPlanSha256, 'startPlanSha256'),
      feedbackSha256: sha(expected.feedbackSha256, 'feedbackSha256'),
      feedbackText: expected.feedbackText,
      author: structuredClone(expected.author), criteria: structuredClone(expected.criteria),
      disposition: structuredClone(expected.disposition),
      privacyPolicySha256: expected.privacyPolicySha256,
      capturedAt: new Date().toISOString(), producer: structuredClone(expected.producer)
    };
    const pin = validateStartPin({ ...core, pinSha256: digest(core) },
      selectedSubject, expected);
    await writeImmutablePrivateSidecar(root, target, Buffer.from(canonicalJson(pin)), {
      maximumBytes: 16 * 1024, enforceWindowsAcl: true
    });
    return pin;
  });
}

export async function readRevisionStartPin(root, selected, startPlanSha256) {
  const selectedSubject = subject(selected);
  const bytes = await readPrivateSidecar(root,
    startPinPath(root, selectedSubject, startPlanSha256), {
      maximumBytes: 16 * 1024, enforceWindowsAcl: true
    });
  let raw;
  try { raw = JSON.parse(bytes); }
  catch { fail('REV_INTERACTIVE_STATE_CORRUPT', 'Revision start pin is not valid JSON.'); }
  return validateStartPin(raw, selectedSubject, {
    startPlanSha256, feedbackSha256: raw?.feedbackSha256,
    feedbackText: raw?.feedbackText, author: raw?.author,
    criteria: raw?.criteria, disposition: raw?.disposition,
    privacyPolicySha256: raw?.privacyPolicySha256, producer: raw?.producer
  });
}
