/**
 * Closed, self-hashed durable REV records.
 *
 * This module deliberately has no execution or publication authority. It only constructs and
 * validates records that other, independently authorized boundaries may persist. In particular,
 * accepting a record here never advances a loop head, runs a provider, or publishes a phase.
 */
import { createHash } from 'node:crypto';

import { canonicalJson, recordSha256 } from '../records.mjs';
import { readRecord, stampCurrentRecord } from '../schema-migrations.mjs';
import { scanText } from '../secrets.mjs';
import { SingularityFlowError } from '../util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLAUSE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_FEEDBACK_BYTES = 8192;
const MAX_FEEDBACK_LINES = 80;
const MAX_CRITERIA = 128;
const MAX_PREDICATES = 64;
const MAX_ATTEMPTS = 64;
const MAX_ACTIONS = 128;
const MAX_REFUSALS = 128;
const MAX_HUNKS = 512;
const PRECHECK_VALIDATIONS = Object.freeze([
  'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope', 'protectedPaths',
  'forbiddenEffects', 'secretScan', 'hunkDisposition', 'criteriaBindingFreshness',
  'specificationDisposition', 'requiredStructure', 'kernelChecks',
  'proofProfileReadiness', 'pendingRecovery', 'worktreeEquality'
]);

const HASH_FIELDS = Object.freeze({
  'revision-loop': 'loopSha256',
  'revision-feedback': 'recordSha256',
  'revision-criteria-binding': 'bindingSha256',
  'revision-specification-disposition': 'dispositionSha256',
  'revision-packet': 'packetSha256',
  'revision-attempt': 'attemptSha256',
  'revision-attempt-restoration': 'restorationReceiptSha256',
  'revision-hunk-claim-set': 'claimSetSha256',
  'revision-precheck': 'precheckSha256',
  'revision-interval': 'intervalSha256',
  'revision-publication-summary': 'summarySha256',
  'revision-recovery-journal': 'journalSha256',
  'revision-explanation': 'explanationSha256'
});

const BUILDABLE = new Set(Object.keys(HASH_FIELDS).filter((kind) => kind !== 'revision-packet'));

function fail(message, details = undefined) {
  throw new SingularityFlowError(message, { code: 'REV_RECORD_INVALID', details });
}
function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(`${label} must be a plain object.`);
  }
  return value;
}
function exact(value, keys, label) {
  plain(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has missing or unknown authority-bearing fields.`, { expected, actual });
  }
  return value;
}
function hash(value) { return `sha256:${recordSha256(value)}`; }
function bytesHash(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(value)).digest('hex')}`;
}
function requiredHash(value, label) {
  if (!HASH.test(String(value ?? ''))) fail(`${label} needs an exact SHA-256 digest.`);
  return value;
}
function nullableHash(value, label) { return value == null ? null : requiredHash(value, label); }
function identifier(value, label, pattern = ID) {
  if (!pattern.test(String(value ?? ''))) fail(`${label} needs a bounded portable identifier.`);
  return value;
}
function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    fail(`${label} must be an exact UTC RFC 3339 timestamp.`);
  }
  return value;
}
function text(value, label, maximum = 1024) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be nonempty, bounded UTF-8 text without control characters.`);
  }
  return value;
}
function unique(values, key, label, maximum) {
  if (!Array.isArray(values) || values.length > maximum) fail(`${label} exceeds its bounded inventory.`);
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) fail(`${label} contains duplicate identities.`);
  return values;
}
function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} is not in the closed vocabulary.`);
  return value;
}
function subject(value) {
  exact(value, ['workId', 'phaseId', 'phaseGeneration'], 'subject');
  return {
    workId: identifier(value.workId, 'subject.workId'),
    phaseId: identifier(value.phaseId, 'subject.phaseId'),
    phaseGeneration: integer(value.phaseGeneration, 'subject.phaseGeneration')
  };
}
function producer(value) {
  exact(value, ['id', 'version', 'implementationSha256'], 'producer');
  return {
    id: identifier(value.id, 'producer.id'),
    version: text(value.version, 'producer.version', 64),
    implementationSha256: requiredHash(value.implementationSha256, 'producer.implementationSha256')
  };
}
function candidate(value, label, { tree = false } = {}) {
  const keys = ['candidateId', 'candidateSha256', ...(tree ? ['candidateTree', 'sourceManifestSha256'] : [])];
  exact(value, keys, label);
  const result = {
    candidateId: identifier(value.candidateId, `${label}.candidateId`, /^CAN-[A-Za-z0-9._:-]{6,127}$/),
    candidateSha256: requiredHash(value.candidateSha256, `${label}.candidateSha256`)
  };
  if (tree) {
    if (!OID.test(String(value.candidateTree ?? ''))) fail(`${label}.candidateTree must be an exact Git object ID.`);
    result.candidateTree = value.candidateTree;
    result.sourceManifestSha256 = requiredHash(value.sourceManifestSha256, `${label}.sourceManifestSha256`);
  }
  return result;
}
function nullableCode(value, label) {
  return value == null ? null : identifier(value, label, /^[A-Z][A-Z0-9_]{1,127}$/);
}
function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean.`);
  return value;
}
function loopCandidate(value, label) {
  exact(value, ['candidateId', 'candidateSha256', 'candidateRefSha256', 'candidateTree'], label);
  identifier(value.candidateId, `${label}.candidateId`, /^CAN-[A-Za-z0-9._:-]{6,127}$/);
  requiredHash(value.candidateSha256, `${label}.candidateSha256`);
  requiredHash(value.candidateRefSha256, `${label}.candidateRefSha256`);
  if (!OID.test(String(value.candidateTree ?? ''))) fail(`${label}.candidateTree must be an exact Git object ID.`);
  return value;
}
function sealed(kind, core) {
  const stamped = stampCurrentRecord(kind, { ...core, kind });
  const field = HASH_FIELDS[kind];
  const record = { ...stamped, [field]: hash(stamped) };
  validateRevisionRecord(kind, record);
  return Object.freeze(record);
}
function verifySeal(kind, record) {
  const field = HASH_FIELDS[kind];
  requiredHash(record[field], `${kind}.${field}`);
  const core = structuredClone(record);
  delete core[field];
  if (hash(core) !== record[field]) fail(`${kind} failed its content hash.`);
}
function boundedRecord(record) {
  let bytes;
  try { bytes = Buffer.byteLength(canonicalJson(record)); }
  catch { fail(`${record?.kind ?? 'REV record'} must be canonical plain JSON.`); }
  if (bytes > MAX_RECORD_BYTES) fail(`${record.kind} exceeds the durable record byte limit.`);
}

function validateFeedback(value) {
  exact(value, [
    'schemaVersion', 'kind', 'feedbackId', 'subject', 'author', 'text', 'bytes',
    'feedbackSha256', 'capturedAt', 'producer', 'recordSha256'
  ], 'revision-feedback');
  identifier(value.feedbackId, 'feedbackId', /^REVFB-[A-Za-z0-9._:-]{6,127}$/);
  subject(value.subject);
  exact(value.author, ['kind', 'id', 'name'], 'feedback author');
  oneOf(value.author.kind, ['configured-local', 'authenticated-user', 'service'], 'author.kind');
  text(value.author.id, 'author.id', 256);
  text(value.author.name, 'author.name', 256);
  text(value.text, 'feedback.text', MAX_FEEDBACK_BYTES);
  if (value.text.split(/\r?\n/u).length > MAX_FEEDBACK_LINES || scanText(value.text).length) {
    fail('Feedback exceeds the line limit or contains a likely secret.');
  }
  if (integer(value.bytes, 'feedback.bytes', { minimum: 1, maximum: MAX_FEEDBACK_BYTES })
      !== Buffer.byteLength(value.text) || value.feedbackSha256 !== bytesHash(value.text)) {
    fail('Feedback bytes or digest do not bind the exact text.');
  }
  timestamp(value.capturedAt, 'capturedAt');
  producer(value.producer);
}

function validateCriteriaBinding(value) {
  exact(value, [
    'schemaVersion', 'kind', 'subject', 'feedbackSha256', 'mode', 'criteria', 'binder',
    'producer', 'bindingSha256'
  ], 'revision-criteria-binding');
  subject(value.subject);
  requiredHash(value.feedbackSha256, 'feedbackSha256');
  oneOf(value.mode, [
    'explicit', 'exact-id', 'exact-phrase', 'structural-reference', 'unscoped', 'ambiguous'
  ], 'criteria binding mode');
  unique(value.criteria, (item) => item?.clauseId, 'criteria', MAX_CRITERIA);
  for (const item of value.criteria) {
    exact(item, ['clauseId', 'clauseSha256'], 'criterion binding');
    identifier(item.clauseId, 'criterion.clauseId', CLAUSE);
    requiredHash(item.clauseSha256, 'criterion.clauseSha256');
  }
  if (value.mode === 'unscoped' ? value.criteria.length !== 0 : value.criteria.length === 0) {
    fail('Only unscoped criteria binding may have an empty criterion set.');
  }
  exact(value.binder, ['id', 'version', 'implementationSha256'], 'criteria binder');
  identifier(value.binder.id, 'binder.id');
  integer(value.binder.version, 'binder.version', { minimum: 1, maximum: 1_000_000 });
  requiredHash(value.binder.implementationSha256, 'binder.implementationSha256');
  producer(value.producer);
}

function validateDisposition(value) {
  exact(value, [
    'schemaVersion', 'kind', 'subject', 'feedbackSha256', 'bindingSha256', 'result',
    'predicateResults', 'humanResolution', 'producer', 'dispositionSha256'
  ], 'revision-specification-disposition');
  subject(value.subject);
  requiredHash(value.feedbackSha256, 'feedbackSha256');
  requiredHash(value.bindingSha256, 'bindingSha256');
  oneOf(value.result, ['implementation-change', 'specification-change', 'ambiguous', 'unrelated'], 'disposition.result');
  unique(value.predicateResults, (item) => item?.predicateId, 'predicateResults', MAX_PREDICATES);
  for (const item of value.predicateResults) {
    exact(item, ['predicateId', 'result'], 'predicate result');
    identifier(item.predicateId, 'predicateId');
    oneOf(item.result, ['pass', 'fail', 'unavailable', 'not-applicable'], 'predicate result');
  }
  if (value.humanResolution !== null) {
    exact(value.humanResolution, ['decision', 'decidedBy', 'decidedAt', 'reason'], 'humanResolution');
    oneOf(value.humanResolution.decision,
      ['implementation-change', 'specification-change', 'unrelated'], 'human resolution decision');
    text(value.humanResolution.decidedBy, 'humanResolution.decidedBy', 256);
    timestamp(value.humanResolution.decidedAt, 'humanResolution.decidedAt');
    text(value.humanResolution.reason, 'humanResolution.reason', 2048);
  }
  if (value.result === 'ambiguous' && value.humanResolution !== null) {
    fail('An ambiguous disposition cannot claim a completed human resolution.');
  }
  producer(value.producer);
}

function validatePacket(value) {
  exact(value, [
    'schemaVersion', 'kind', 'subject', 'routePlanSha256', 'parentCandidate', 'feedback',
    'attachments', 'criteria', 'criteriaBindingSha256', 'specificationDispositionSha256',
    'rules', 'rulesSha256', 'diff', 'diffSha256', 'skeletons', 'skeletonSetSha256',
    'effectPolicy', 'effectPolicySha256', 'expansions', 'budgets', 'producer', 'packetSha256'
  ], 'revision-packet');
  subject(value.subject);
  requiredHash(value.routePlanSha256, 'routePlanSha256');
  exact(value.parentCandidate, ['candidateId', 'candidateSha256', 'candidateRefSha256'], 'packet parent candidate');
  identifier(value.parentCandidate.candidateId, 'parentCandidate.candidateId', /^CAN-[A-Za-z0-9._:-]{6,127}$/);
  requiredHash(value.parentCandidate.candidateSha256, 'parentCandidate.candidateSha256');
  requiredHash(value.parentCandidate.candidateRefSha256, 'parentCandidate.candidateRefSha256');
  const feedbackKeys = [
    'feedbackId', 'feedbackRecordSha256', 'feedbackSha256', 'text',
    ...(value.feedback?.attachmentSetSha256 == null ? [] : ['attachmentSetSha256'])
  ];
  exact(value.feedback, feedbackKeys, 'packet.feedback');
  identifier(value.feedback.feedbackId, 'packet.feedback.feedbackId', /^REVFB-[A-Za-z0-9._:-]{6,127}$/);
  requiredHash(value.feedback.feedbackRecordSha256, 'packet.feedback.feedbackRecordSha256');
  requiredHash(value.feedback.feedbackSha256, 'packet.feedback.feedbackSha256');
  text(value.feedback.text, 'packet.feedback.text', MAX_FEEDBACK_BYTES);
  if (value.feedback.feedbackSha256 !== bytesHash(value.feedback.text)) {
    fail('Packet feedback digest does not bind its exact text.');
  }
  if (value.feedback.attachmentSetSha256 != null) {
    requiredHash(value.feedback.attachmentSetSha256, 'packet.feedback.attachmentSetSha256');
  }
  if (!Array.isArray(value.attachments) || !Array.isArray(value.skeletons)
      || !Array.isArray(value.expansions) || typeof value.diff !== 'string') {
    fail('Revision packet inventories and diff are malformed.');
  }
  exact(value.criteria, ['items'], 'packet.criteria');
  unique(value.criteria.items, (item) => item?.id, 'packet.criteria.items', MAX_CRITERIA);
  if (!value.criteria.items.length) fail('Packet criteria cannot be empty.');
  for (const item of value.criteria.items) {
    exact(item, ['id', 'text'], 'packet criterion');
    text(item.id, 'packet criterion ID', 128);
    text(item.text, 'packet criterion text', 8192);
  }
  exact(value.rules, ['task', 'writeScope', 'protectedPaths'], 'packet.rules');
  oneOf(value.rules.task, ['code'], 'packet.rules.task');
  oneOf(value.rules.writeScope, ['source-and-artifact'], 'packet.rules.writeScope');
  unique(value.rules.protectedPaths, (item) => item, 'packet.rules.protectedPaths', 256);
  if (value.rules.protectedPaths.some((item) => typeof item !== 'string' || !item.trim())) {
    fail('Packet protected paths must be nonempty strings.');
  }
  exact(value.effectPolicy, [
    'writeScope', 'maximumChangedFiles', 'protectedPaths', 'protectedPathsSha256',
    'applicationPathPolicySha256', 'externalEffectsAllowed'
  ], 'packet.effectPolicy');
  oneOf(value.effectPolicy.writeScope, ['source-and-artifact'], 'packet.effectPolicy.writeScope');
  integer(value.effectPolicy.maximumChangedFiles, 'packet.effectPolicy.maximumChangedFiles', {
    minimum: 1, maximum: 128
  });
  unique(value.effectPolicy.protectedPaths, (item) => item,
    'packet.effectPolicy.protectedPaths', 256);
  for (const item of value.effectPolicy.protectedPaths) text(item, 'protected path', 1024);
  requiredHash(value.effectPolicy.protectedPathsSha256, 'protectedPathsSha256');
  requiredHash(value.effectPolicy.applicationPathPolicySha256, 'applicationPathPolicySha256');
  if (value.effectPolicy.externalEffectsAllowed !== false) {
    fail('Guarded revision packets cannot authorize external effects.');
  }
  for (const item of value.attachments) {
    exact(item, [
      'kind', 'displayName', 'mediaType', 'originalSha256', 'renditionSha256',
      'selectedRanges', 'text'
    ], 'packet attachment');
    oneOf(item.kind, ['untrusted-user-document-rendition'], 'packet attachment kind');
    text(item.displayName, 'attachment displayName', 512);
    text(item.mediaType, 'attachment mediaType', 128);
    requiredHash(item.originalSha256, 'attachment originalSha256');
    requiredHash(item.renditionSha256, 'attachment renditionSha256');
    if (!Array.isArray(item.selectedRanges) || typeof item.text !== 'string') {
      fail('Packet attachment selection or text is malformed.');
    }
  }
  for (const item of value.skeletons) {
    exact(item, ['path', 'operation', 'type'], 'packet skeleton');
    text(item.path, 'skeleton path', 2048);
    text(item.operation, 'skeleton operation', 128);
    text(item.type, 'skeleton type', 128);
  }
  if (value.expansions.length) fail('Guarded revision packets cannot carry expansion handles.');
  exact(value.budgets, [
    'maximumInputBytes', 'maximumOutputBytes', 'maximumToolCalls', 'maximumSubattempts'
  ], 'packet budgets');
  for (const [key, maximum] of Object.entries({
    maximumInputBytes: 128 * 1024, maximumOutputBytes: 1024 * 1024,
    maximumToolCalls: 50, maximumSubattempts: 3
  })) integer(value.budgets[key], `budgets.${key}`, { minimum: 1, maximum });
  producer(value.producer);
  for (const field of [
    'criteriaBindingSha256', 'specificationDispositionSha256', 'rulesSha256', 'diffSha256',
    'skeletonSetSha256', 'effectPolicySha256'
  ]) requiredHash(value[field], field);
}

function validateHunkClaimSet(value) {
  exact(value, [
    'schemaVersion', 'kind', 'subject', 'parentCandidateId', 'resultCandidateId',
    'claims', 'unexplained', 'producer', 'claimSetSha256'
  ], 'revision-hunk-claim-set');
  subject(value.subject);
  identifier(value.parentCandidateId, 'parentCandidateId', /^CAN-[A-Za-z0-9._:-]{6,127}$/);
  identifier(value.resultCandidateId, 'resultCandidateId', /^CAN-[A-Za-z0-9._:-]{6,127}$/);
  unique(value.claims, (item) => item?.hunkId, 'hunk claims', MAX_HUNKS);
  for (const item of value.claims) {
    exact(item, ['hunkId', 'cause', 'status'], 'hunk claim');
    identifier(item.hunkId, 'hunkId');
    exact(item.cause, ['kind', 'id'], 'hunk claim cause');
    oneOf(item.cause.kind, [
      'feedback', 'criterion', 'registered-tool-effect', 'manual-note',
      'approved-existing-drift'
    ], 'hunk claim cause kind');
    identifier(item.cause.id, 'hunk claim cause ID');
    if (item.status !== 'claimed') fail('Hunk claim status must be claimed.');
  }
  unique(value.unexplained, (item) => item, 'unexplained hunks', MAX_HUNKS);
  for (const item of value.unexplained) identifier(item, 'unexplained hunk');
  if (value.unexplained.some((hunkId) => value.claims.some((claim) => claim.hunkId === hunkId))) {
    fail('A hunk cannot be both claimed and unexplained.');
  }
  producer(value.producer);
}

function validatePrecheck(value) {
  exact(value, [
    'schemaVersion', 'kind', 'subject', 'candidateId', 'candidateSha256',
    'candidateRefSha256', 'candidateTree', 'headSnapshotSha256', 'headRevision',
    'headTransitionSha256', 'phaseGeneration', 'workflowSha256', 'configSha256',
    'proofProfile', 'proofProfileSha256', 'editorDiskIndexBaselineSha256',
    'criteriaBindingSha256', 'specificationDispositionSha256', 'hunkClaimSetSha256',
    'precheckInputsSha256', 'criteria', 'owed', 'unexplainedHunks', 'refusalSummary',
    'deterministicChecks', 'remainingObligations', 'precheckPassed',
    'publicationEligible', 'producer', 'precheckSha256'
  ], 'revision-precheck');
  const selectedSubject = subject(value.subject);
  identifier(value.candidateId, 'precheck.candidateId', /^CAN-[A-Za-z0-9._:-]{6,127}$/);
  for (const field of [
    'candidateSha256', 'candidateRefSha256', 'headSnapshotSha256',
    'headTransitionSha256', 'workflowSha256', 'configSha256', 'proofProfileSha256',
    'editorDiskIndexBaselineSha256', 'criteriaBindingSha256',
    'specificationDispositionSha256', 'hunkClaimSetSha256', 'precheckInputsSha256'
  ]) requiredHash(value[field], `precheck.${field}`);
  if (!OID.test(String(value.candidateTree ?? ''))) fail('precheck.candidateTree must be an exact Git object ID.');
  integer(value.headRevision, 'precheck.headRevision');
  if (integer(value.phaseGeneration, 'precheck.phaseGeneration') !== selectedSubject.phaseGeneration) {
    fail('Precheck phase generation differs from its subject.');
  }
  oneOf(value.proofProfile, ['standard', 'high-assurance', 'regulated'], 'precheck.proofProfile');
  unique(value.criteria, (item) => item?.clauseId, 'precheck criteria', MAX_CRITERIA);
  for (const item of value.criteria) {
    exact(item, [
      'clauseId', 'readiness', 'reason', 'witnessCount',
      'executedAgainstCandidate', 'staleWitnessCount'
    ], 'precheck criterion');
    identifier(item.clauseId, 'precheck criterion clauseId');
    oneOf(item.readiness, [
      'addressed', 'witness-ready', 'witness-passed-current', 'owed',
      'unavailable', 'contradicted', 'not-applicable'
    ], 'precheck criterion readiness');
    text(item.reason, 'precheck criterion reason', 256);
    integer(item.witnessCount, 'precheck criterion witnessCount');
    integer(item.staleWitnessCount, 'precheck criterion staleWitnessCount');
    boolean(item.executedAgainstCandidate, 'precheck criterion executedAgainstCandidate');
  }
  unique(value.owed, (item) => item, 'precheck owed criteria', MAX_CRITERIA);
  value.owed.forEach((item) => identifier(item, 'owed criterion'));
  unique(value.unexplainedHunks, (item) => item, 'precheck unexplained hunks', MAX_HUNKS);
  value.unexplainedHunks.forEach((item) => identifier(item, 'precheck unexplained hunk'));
  exact(value.refusalSummary, ['count', 'corrected', 'unresolved'], 'precheck refusal summary');
  for (const key of ['count', 'corrected', 'unresolved']) {
    integer(value.refusalSummary[key], `precheck refusalSummary.${key}`);
  }
  if (value.refusalSummary.corrected + value.refusalSummary.unresolved
      !== value.refusalSummary.count) fail('Precheck refusal summary totals are inconsistent.');
  exact(value.deterministicChecks, PRECHECK_VALIDATIONS, 'precheck deterministic checks');
  for (const key of PRECHECK_VALIDATIONS) {
    exact(value.deterministicChecks[key], ['status', 'evidenceSha256'], `precheck check ${key}`);
    oneOf(value.deterministicChecks[key].status, ['pass', 'fail', 'unavailable'], `precheck check ${key} status`);
    requiredHash(value.deterministicChecks[key].evidenceSha256, `precheck check ${key} evidence`);
  }
  unique(value.remainingObligations, (item) => item, 'precheck obligations', 512);
  value.remainingObligations.forEach((item) => text(item, 'precheck obligation', 256));
  boolean(value.precheckPassed, 'precheck.precheckPassed');
  boolean(value.publicationEligible, 'precheck.publicationEligible');
  producer(value.producer);
}

function validateInterval(value) {
  exact(value, [
    'schemaVersion', 'kind', 'intervalId', 'sequence', 'subject', 'trigger',
    'parentCandidate', 'resultCandidate', 'packetSha256', 'criteriaBindingSha256',
    'specificationDispositionSha256', 'executionAttempts', 'hunkClaimSetSha256',
    'startedAt', 'endedAt', 'producer', 'precheckSha256', 'status', 'intervalSha256'
  ], 'revision-interval');
  subject(value.subject);
  identifier(value.intervalId, 'intervalId', /^REV-[A-Za-z0-9._:-]{4,127}$/);
  integer(value.sequence, 'interval.sequence', { minimum: 1 });
  exact(value.trigger, [
    'kind', 'feedbackId', 'author', 'feedbackSha256', 'feedbackRecordSha256',
    'criteriaBindingSha256', 'specificationDispositionSha256', 'startPinSha256',
    'noteSha256'
  ], 'interval trigger');
  if (value.trigger.kind !== 'developer-feedback') fail('Interval trigger kind is invalid.');
  identifier(value.trigger.feedbackId, 'interval feedbackId', /^REVFB-[A-Za-z0-9._:-]{6,127}$/);
  exact(value.trigger.author, ['kind', 'id', 'name'], 'interval feedback author');
  oneOf(value.trigger.author.kind, ['configured-local', 'authenticated-user', 'service'], 'interval author kind');
  text(value.trigger.author.id, 'interval author ID', 256);
  text(value.trigger.author.name, 'interval author name', 256);
  for (const field of [
    'feedbackSha256', 'feedbackRecordSha256', 'criteriaBindingSha256',
    'specificationDispositionSha256', 'startPinSha256', 'noteSha256'
  ]) requiredHash(value.trigger[field], `interval trigger ${field}`);
  loopCandidate(value.parentCandidate, 'interval parentCandidate');
  loopCandidate(value.resultCandidate, 'interval resultCandidate');
  for (const field of [
    'packetSha256', 'criteriaBindingSha256', 'specificationDispositionSha256',
    'hunkClaimSetSha256', 'precheckSha256'
  ]) requiredHash(value[field], `interval.${field}`);
  if (value.criteriaBindingSha256 !== value.trigger.criteriaBindingSha256
      || value.specificationDispositionSha256 !== value.trigger.specificationDispositionSha256) {
    fail('Interval trigger and durable record bindings differ.');
  }
  unique(value.executionAttempts, (item) => item, 'interval execution attempts', MAX_ATTEMPTS);
  if (!value.executionAttempts.length) fail('Interval requires at least one execution attempt.');
  value.executionAttempts.forEach((item) => requiredHash(item, 'interval execution attempt'));
  timestamp(value.startedAt, 'interval.startedAt');
  timestamp(value.endedAt, 'interval.endedAt');
  if (value.endedAt < value.startedAt) fail('Interval endedAt precedes startedAt.');
  if (value.status !== 'prechecked') fail('Only a prechecked admitted interval is durable here.');
  producer(value.producer);
}

function validateLoop(value) {
  exact(value, [
    'schemaVersion', 'kind', 'subject', 'workflow', 'initialCandidateId',
    'headCandidateId', 'headIntervalId', 'state', 'revision', 'segments',
    'producer', 'loopSha256'
  ], 'revision-loop');
  subject(value.subject);
  exact(value.workflow, ['definitionSha256', 'configurationSha256'], 'revision loop workflow');
  requiredHash(value.workflow.definitionSha256, 'loop workflow definition');
  requiredHash(value.workflow.configurationSha256, 'loop workflow configuration');
  identifier(value.initialCandidateId, 'loop initialCandidateId', /^CAN-[A-Za-z0-9._:-]{6,127}$/);
  identifier(value.headCandidateId, 'loop headCandidateId', /^CAN-[A-Za-z0-9._:-]{6,127}$/);
  if (value.headIntervalId !== null) identifier(value.headIntervalId, 'loop headIntervalId', /^REV-[A-Za-z0-9._:-]{4,127}$/);
  oneOf(value.state, ['open', 'abandoned'], 'loop state');
  integer(value.revision, 'loop revision');
  unique(value.segments, (item) => item?.segment, 'loop segments', 100_000);
  let priorLast = 0;
  for (const [index, item] of value.segments.entries()) {
    exact(item, ['segment', 'firstSequence', 'lastSequence', 'intervalSetSha256'], 'loop segment');
    const segment = integer(item.segment, 'loop segment number', { minimum: 1 });
    const first = integer(item.firstSequence, 'loop segment firstSequence', { minimum: 1 });
    const last = integer(item.lastSequence, 'loop segment lastSequence', { minimum: first });
    if (segment !== index + 1 || first !== priorLast + 1) fail('Loop segments must be contiguous and ordered.');
    priorLast = last;
    requiredHash(item.intervalSetSha256, 'loop segment interval set');
  }
  producer(value.producer);
}

function validateAttempt(value) {
  exact(value, [
    'schemaVersion', 'kind', 'attemptId', 'intervalId', 'sequence', 'subject',
    'parentCandidate', 'provider', 'status', 'reasonCode', 'effectSetSha256',
    'resultCandidate', 'restorationReceiptSha256', 'startedAt', 'endedAt', 'producer',
    'attemptSha256'
  ], 'revision-attempt');
  identifier(value.attemptId, 'attemptId', /^REVATT-[A-Za-z0-9._:-]{4,127}$/);
  identifier(value.intervalId, 'intervalId', /^REV-[A-Za-z0-9._:-]{4,127}$/);
  integer(value.sequence, 'attempt.sequence', { minimum: 1, maximum: MAX_ATTEMPTS });
  subject(value.subject);
  candidate(value.parentCandidate, 'parentCandidate');
  exact(value.provider, ['id', 'version', 'implementationSha256'], 'attempt provider');
  identifier(value.provider.id, 'provider.id');
  text(value.provider.version, 'provider.version', 64);
  requiredHash(value.provider.implementationSha256, 'provider.implementationSha256');
  oneOf(value.status, [
    'started', 'refused-restored', 'failed-restored', 'cancelled-restored',
    'candidate-frozen', 'recovery-required'
  ], 'attempt.status');
  nullableCode(value.reasonCode, 'attempt.reasonCode');
  nullableHash(value.effectSetSha256, 'attempt.effectSetSha256');
  if (value.resultCandidate !== null) candidate(value.resultCandidate, 'resultCandidate', { tree: true });
  nullableHash(value.restorationReceiptSha256, 'attempt.restorationReceiptSha256');
  timestamp(value.startedAt, 'attempt.startedAt');
  if (value.endedAt !== null) timestamp(value.endedAt, 'attempt.endedAt');
  if (value.status === 'started') {
    if (value.endedAt !== null || value.reasonCode !== null || value.resultCandidate !== null
        || value.restorationReceiptSha256 !== null) fail('A started attempt cannot claim an outcome.');
  } else if (value.endedAt === null) fail('A completed attempt needs endedAt.');
  if (value.status.endsWith('-restored') && (!value.reasonCode || !value.restorationReceiptSha256)) {
    fail('A restored attempt must bind its refusal and restoration receipt.');
  }
  if (value.status === 'candidate-frozen' && (!value.resultCandidate || !value.effectSetSha256
      || value.reasonCode !== null || value.restorationReceiptSha256 !== null)) {
    fail('A frozen attempt must bind one result candidate and no restoration.');
  }
  if (value.status === 'recovery-required' && !value.reasonCode) {
    fail('A recovery-required attempt needs an exact reason code.');
  }
  producer(value.producer);
}

function validateRestoration(value) {
  exact(value, [
    'schemaVersion', 'kind', 'subject', 'attemptId', 'parentCandidate', 'preimageSha256',
    'postimageSha256', 'processTreeQuiesced', 'filesystemRestored', 'externalEffectsAbsent',
    'status', 'reasonCode', 'restoredAt', 'producer', 'restorationReceiptSha256'
  ], 'revision-attempt-restoration');
  subject(value.subject);
  identifier(value.attemptId, 'attemptId', /^REVATT-[A-Za-z0-9._:-]{4,127}$/);
  candidate(value.parentCandidate, 'parentCandidate');
  requiredHash(value.preimageSha256, 'preimageSha256');
  requiredHash(value.postimageSha256, 'postimageSha256');
  for (const field of ['processTreeQuiesced', 'filesystemRestored', 'externalEffectsAbsent']) {
    if (typeof value[field] !== 'boolean') fail(`${field} must be boolean.`);
  }
  oneOf(value.status, ['restored', 'failed', 'uncertain'], 'restoration.status');
  nullableCode(value.reasonCode, 'restoration.reasonCode');
  timestamp(value.restoredAt, 'restoredAt');
  if (value.status === 'restored') {
    if (!value.processTreeQuiesced || !value.filesystemRestored || !value.externalEffectsAbsent
        || value.preimageSha256 !== value.postimageSha256 || value.reasonCode !== null) {
      fail('A restored receipt must prove quiescence, exact preimage restoration, and no external effects.');
    }
  } else if (!value.reasonCode) fail('A non-restored receipt needs an exact reason code.');
  producer(value.producer);
}

function validatePublicationSummary(value) {
  exact(value, [
    'schemaVersion', 'kind', 'subject', 'revisionLoop', 'publishedCandidate', 'chain',
    'publishedAt', 'producer', 'summarySha256'
  ], 'revision-publication-summary');
  subject(value.subject);
  exact(value.revisionLoop, [
    'intervalCount', 'initialCandidateId', 'publishedCandidateId', 'loopSha256',
    'intervalSetSha256', 'correctedRefusalCount', 'unresolvedRefusalCount'
  ], 'revisionLoop');
  integer(value.revisionLoop.intervalCount, 'revisionLoop.intervalCount');
  identifier(value.revisionLoop.initialCandidateId, 'initialCandidateId', /^CAN-[A-Za-z0-9._:-]{6,127}$/);
  identifier(value.revisionLoop.publishedCandidateId, 'publishedCandidateId', /^CAN-[A-Za-z0-9._:-]{6,127}$/);
  requiredHash(value.revisionLoop.loopSha256, 'loopSha256');
  requiredHash(value.revisionLoop.intervalSetSha256, 'intervalSetSha256');
  integer(value.revisionLoop.correctedRefusalCount, 'correctedRefusalCount');
  integer(value.revisionLoop.unresolvedRefusalCount, 'unresolvedRefusalCount');
  if (value.revisionLoop.unresolvedRefusalCount !== 0) fail('Publication cannot summarize unresolved refusals.');
  const selected = candidate(value.publishedCandidate, 'publishedCandidate', { tree: true });
  if (selected.candidateId !== value.revisionLoop.publishedCandidateId) {
    fail('Published candidate differs from the revision-loop summary.');
  }
  exact(value.chain, ['path', 'manifestSha256', 'chainSha256'], 'publication chain');
  text(value.chain.path, 'chain.path', 1024);
  if (value.chain.path.startsWith('/') || value.chain.path.includes('\\')
      || value.chain.path.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('Publication chain path must remain repository-relative.');
  }
  requiredHash(value.chain.manifestSha256, 'chain.manifestSha256');
  requiredHash(value.chain.chainSha256, 'chain.chainSha256');
  timestamp(value.publishedAt, 'publishedAt');
  producer(value.producer);
}

function validateRecoveryJournal(value) {
  exact(value, [
    'schemaVersion', 'kind', 'journalId', 'subject', 'loopId', 'state', 'reasonCode',
    'rescueContentSha256', 'actions', 'createdAt', 'updatedAt', 'producer', 'journalSha256'
  ], 'revision-recovery-journal');
  identifier(value.journalId, 'journalId', /^REVREC-[A-Za-z0-9._:-]{5,127}$/);
  subject(value.subject);
  identifier(value.loopId, 'loopId');
  oneOf(value.state, ['pending', 'resolved', 'abandoned'], 'recovery.state');
  nullableCode(value.reasonCode, 'recovery.reasonCode');
  nullableHash(value.rescueContentSha256, 'rescueContentSha256');
  unique(value.actions, (item) => item?.sequence, 'recovery actions', MAX_ACTIONS);
  let previous = 0;
  for (const item of value.actions) {
    exact(item, ['sequence', 'kind', 'status', 'receiptSha256'], 'recovery action');
    const sequence = integer(item.sequence, 'action.sequence', { minimum: 1, maximum: MAX_ACTIONS });
    if (sequence !== previous + 1) fail('Recovery action sequence must be contiguous.');
    previous = sequence;
    oneOf(item.kind, ['quiesce', 'restore', 'inspect', 'reconcile', 'abandon'], 'action.kind');
    oneOf(item.status, ['planned', 'succeeded', 'failed'], 'action.status');
    nullableHash(item.receiptSha256, 'action.receiptSha256');
    if (item.status === 'succeeded' && !item.receiptSha256) fail('A succeeded recovery action needs a receipt.');
  }
  timestamp(value.createdAt, 'createdAt');
  timestamp(value.updatedAt, 'updatedAt');
  if (value.updatedAt < value.createdAt || (value.state === 'pending' && !value.reasonCode)) {
    fail('Recovery journal timestamps or pending reason are invalid.');
  }
  producer(value.producer);
}

function validateExplanation(value) {
  exact(value, [
    'schemaVersion', 'kind', 'subject', 'loopSha256', 'intervalId', 'feedbackSha256',
    'parentCandidate', 'resultCandidate', 'attemptCount', 'refusals', 'precheckSha256',
    'authority', 'producer', 'explanationSha256'
  ], 'revision-explanation');
  subject(value.subject);
  requiredHash(value.loopSha256, 'loopSha256');
  identifier(value.intervalId, 'intervalId', /^REV-[A-Za-z0-9._:-]{4,127}$/);
  requiredHash(value.feedbackSha256, 'feedbackSha256');
  candidate(value.parentCandidate, 'parentCandidate');
  candidate(value.resultCandidate, 'resultCandidate');
  integer(value.attemptCount, 'attemptCount', { minimum: 1, maximum: MAX_ATTEMPTS });
  unique(value.refusals, (item) => `${item?.attemptId}\0${item?.code}`, 'refusals', MAX_REFUSALS);
  for (const item of value.refusals) {
    exact(item, ['attemptId', 'code', 'resourcesSha256', 'corrected'], 'refusal explanation');
    identifier(item.attemptId, 'refusal.attemptId', /^REVATT-[A-Za-z0-9._:-]{4,127}$/);
    nullableCode(item.code, 'refusal.code');
    requiredHash(item.resourcesSha256, 'refusal.resourcesSha256');
    if (typeof item.corrected !== 'boolean') fail('refusal.corrected must be boolean.');
  }
  if (value.refusals.length > value.attemptCount) fail('Refusal count cannot exceed attempt count.');
  requiredHash(value.precheckSha256, 'precheckSha256');
  if (value.authority !== 'deterministic-records') fail('Revision explanation has no authority beyond deterministic records.');
  producer(value.producer);
}

const VALIDATORS = Object.freeze({
  'revision-loop': validateLoop,
  'revision-feedback': validateFeedback,
  'revision-criteria-binding': validateCriteriaBinding,
  'revision-specification-disposition': validateDisposition,
  'revision-packet': validatePacket,
  'revision-attempt': validateAttempt,
  'revision-attempt-restoration': validateRestoration,
  'revision-hunk-claim-set': validateHunkClaimSet,
  'revision-precheck': validatePrecheck,
  'revision-interval': validateInterval,
  'revision-publication-summary': validatePublicationSummary,
  'revision-recovery-journal': validateRecoveryJournal,
  'revision-explanation': validateExplanation
});

/** Validate exact current bytes; this never upgrades or rewrites stored evidence. */
export function validateRevisionRecord(kind, raw) {
  if (!Object.hasOwn(VALIDATORS, kind)) fail(`Unknown REV record family '${String(kind)}'.`);
  let record;
  try { record = readRecord(kind, raw).record; }
  catch (error) {
    if (error instanceof SingularityFlowError && error.code === 'REV_RECORD_INVALID') throw error;
    fail(`REV record '${kind}' is not readable at the installed schema version.`, { cause: error?.code ?? null });
  }
  if (record.kind !== kind) fail(`Expected kind '${kind}', received '${String(record.kind)}'.`);
  VALIDATORS[kind](record);
  verifySeal(kind, record);
  boundedRecord(record);
  return Object.freeze(structuredClone(record));
}

export function revisionRecordHashField(kind) {
  if (!Object.hasOwn(HASH_FIELDS, kind)) fail(`Unknown REV record family '${String(kind)}'.`);
  return HASH_FIELDS[kind];
}

/** Builders are deliberately generic: callers cannot smuggle an unregistered field into a record. */
export function buildRevisionRecord(kind, value) {
  if (!BUILDABLE.has(kind)) fail(`REV family '${String(kind)}' has no generic durable builder.`);
  if (!plain(value, kind) || Object.hasOwn(value, 'schemaVersion') || Object.hasOwn(value, 'kind')
      || Object.hasOwn(value, HASH_FIELDS[kind])) {
    fail(`Builder input for '${kind}' must omit stamped and self-hash fields.`);
  }
  return sealed(kind, structuredClone(value));
}

export const buildRevisionFeedback = (value) => buildRevisionRecord('revision-feedback', value);
export const buildRevisionCriteriaBinding = (value) => buildRevisionRecord('revision-criteria-binding', value);
export const buildRevisionSpecificationDisposition = (value) =>
  buildRevisionRecord('revision-specification-disposition', value);
export const buildRevisionAttempt = (value) => buildRevisionRecord('revision-attempt', value);
export const buildRevisionAttemptRestoration = (value) =>
  buildRevisionRecord('revision-attempt-restoration', value);
export const buildRevisionHunkClaimSet = (value) =>
  buildRevisionRecord('revision-hunk-claim-set', value);
export const buildRevisionPrecheck = (value) => buildRevisionRecord('revision-precheck', value);
export const buildRevisionInterval = (value) => buildRevisionRecord('revision-interval', value);
export const buildRevisionLoop = (value) => buildRevisionRecord('revision-loop', value);
export const buildRevisionPublicationSummary = (value) =>
  buildRevisionRecord('revision-publication-summary', value);
export const buildRevisionRecoveryJournal = (value) =>
  buildRevisionRecord('revision-recovery-journal', value);
export const buildRevisionExplanation = (value) => buildRevisionRecord('revision-explanation', value);

export const REV_DURABLE_RECORD_FAMILIES = Object.freeze(Object.keys(HASH_FIELDS));
