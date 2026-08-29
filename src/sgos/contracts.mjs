import { createHash } from 'node:crypto';

import { canonicalJson } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';
import { canonicalizeSgosAbsolutePath } from './paths.mjs';

export const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const INTENT_SOURCE_KINDS = Object.freeze([
  'natural-language', 'structured-api', 'jira-issue', 'document', 'goal',
  'incident-event', 'policy-change', 'existing-adhoc-work', 'scheduled-trigger',
  'external-system-signal'
]);

export const INTENT_PROVENANCE = Object.freeze([
  'explicit', 'human-confirmed', 'source-imported', 'policy-derived', 'domain-derived',
  'deterministic-derived', 'model-proposed', 'defaulted', 'reverse-converged'
]);

export const WORKFLOW_CONSTRUCTS = Object.freeze([
  'task', 'sequence', 'parallel', 'foreach', 'bounded-loop', 'condition',
  'human-request', 'join', 'merge', 'subprocess', 'compensation', 'checkpoint', 'end'
]);

export const GVM_OPCODES = Object.freeze([
  'KERNEL', 'AGENT', 'DEVICE', 'VERIFY', 'HUMAN_REQUEST', 'JOIN', 'MERGE',
  'CHECKPOINT', 'SPAWN', 'COMPENSATE', 'NOOP', 'END'
]);

export const TASK_STATES = Object.freeze([
  'planned', 'waiting', 'ready', 'leased', 'running', 'waiting-human', 'verifying',
  'succeeded', 'failed', 'blocked', 'cancelled', 'invalidated', 'recovery-required',
  'skipped'
]);

export const PROCESS_STATES = Object.freeze([
  'queued', 'running', 'waiting-human', 'blocked', 'paused', 'succeeded', 'failed',
  'cancelled', 'recovery-required'
]);

export const HUMAN_REQUEST_TYPES = Object.freeze([
  'clarification', 'approval', 'credential', 'exception', 'policy-choice',
  'conflict-resolution', 'interpretation', 'evidence-review', 'scope-expansion',
  'production-authority', 'scientific-judgment', 'legal-judgment'
]);

export const WORK_OBJECT_VIEW_TYPES = Object.freeze([
  'form', 'table', 'timeline', 'graph', 'comparison', 'dashboard', 'evidence-matrix',
  'decision-card', 'map', 'code-source-diff', 'experiment-result'
]);

export const WORK_OBJECT_OPERATIONS = Object.freeze([
  // `human-request.respond` remains readable for v1 projections emitted before the CLI operation
  // IDs were unified. New projections emit the registered `request.respond` command ID.
  'request.respond', 'human-request.respond', 'process.pause', 'process.resume', 'candidate.review',
  'evidence.inspect', 'work-object.refresh'
]);

const POLICY_DIGEST_FIELDS = Object.freeze([
  'lawSha256', 'registrySha256', 'executionUnitPolicySha256', 'devicePolicySha256',
  'storagePolicySha256', 'memoryPolicySha256', 'humanAuthoritySha256',
  'governedRootsSha256', 'verificationPolicySha256', 'publicationPolicySha256'
]);

const CONTRACTS = Object.freeze({
  'intent-envelope': Object.freeze({ kind: 'intent-envelope', hash: 'envelopeSha256', id: 'intentId', prefix: 'INT' }),
  'intent-ir': Object.freeze({ kind: 'intent-ir', hash: 'intentIrSha256', id: 'intentId', prefix: 'INT' }),
  'workflow-ir': Object.freeze({ kind: 'workflow-ir', hash: 'workflowSha256', id: 'workflowId', prefix: 'WFL' }),
  'workflow-ratification': Object.freeze({ kind: 'workflow-ratification', hash: 'ratificationSha256', id: 'ratificationId', prefix: 'RAT' }),
  'policy-snapshot': Object.freeze({ kind: 'policy-snapshot', hash: 'snapshotSha256', id: 'policyId', prefix: 'POL' }),
  'candidate-snapshot': Object.freeze({ kind: 'candidate-snapshot', hash: 'candidateSha256', id: 'candidateId', prefix: 'CAN' }),
  'process-binding': Object.freeze({ kind: 'process-binding', hash: 'bindingSha256' }),
  'gvm-program': Object.freeze({ kind: 'gvm-program', hash: 'programSha256', id: 'programId', prefix: 'PRG' }),
  'gvm-process': Object.freeze({ kind: 'gvm-process', hash: 'processSha256', id: 'processId', prefix: 'PROC' }),
  'sgos-record-index': Object.freeze({ kind: 'sgos-record-index', hash: 'recordIndexSha256' }),
  'sgos-control-event': Object.freeze({ kind: 'sgos-control-event', hash: 'controlEventSha256' }),
  'sgos-control-successor': Object.freeze({ kind: 'sgos-control-successor', hash: 'successorSha256' }),
  'sgos-transition-intent': Object.freeze({ kind: 'sgos-transition-intent', hash: 'intentSha256' }),
  'gvm-task-attempt': Object.freeze({ kind: 'gvm-task-attempt', hash: 'attemptSha256', id: 'attemptId', prefix: 'ATT' }),
  'gvm-task-receipt': Object.freeze({ kind: 'gvm-task-receipt', hash: 'receiptSha256' }),
  'gvm-checkpoint': Object.freeze({ kind: 'gvm-checkpoint', hash: 'checkpointSha256', id: 'checkpointId', prefix: 'CHK' }),
  'human-request': Object.freeze({ kind: 'human-request', hash: 'requestSha256', id: 'requestId', prefix: 'HRQ' }),
  'human-response': Object.freeze({ kind: 'human-response', hash: 'responseSha256', id: 'responseId', prefix: 'HRS' }),
  'action-evidence': Object.freeze({ kind: 'action-evidence', hash: 'evidenceSha256' }),
  'work-object': Object.freeze({ kind: 'work-object', hash: 'objectSha256', id: 'objectId', prefix: 'WKO' })
});

function fail(message, details = {}) {
  throw new SingularityFlowError(message, { code: 'SGOS_CONTRACT_INVALID', details });
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, location = '$', seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${location} must contain only finite JSON numbers.`);
    return value;
  }
  if (typeof value !== 'object') fail(`${location} must be JSON-safe; received ${typeof value}.`);
  if (seen.has(value)) fail(`${location} contains a cycle.`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => cloneJson(entry, `${location}[${index}]`, seen));
  } else {
    if (!plainObject(value)) fail(`${location} must contain only plain JSON objects.`);
    result = {};
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${location} contains unsafe key '${key}'.`);
      result[key] = cloneJson(value[key], `${location}.${key}`, seen);
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

export function cloneSgosValue(value) {
  return cloneJson(value);
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : typeof value === 'string' ? value : canonicalJson(cloneJson(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function deterministicSgosId(prefix, identity) {
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(prefix)) fail(`Invalid SGOS ID prefix '${prefix}'.`);
  return `${prefix}-${sha256({ namespace: 'sflow/sgos/v1', prefix, identity: cloneJson(identity) }).slice(7, 39).toUpperCase()}`;
}

export function recordSelfSha256(record, hashField) {
  if (!plainObject(record)) fail('A governed record must be a plain object.');
  if (typeof hashField !== 'string' || !hashField) fail('A self-hash field is required.');
  const core = cloneJson(record);
  delete core[hashField];
  return sha256(core);
}

function object(value, label) {
  if (!plainObject(value)) fail(`${label} must be an object.`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) fail(`${label} contains unknown field '${key}'.`, { field: key });
  }
}

function requireKeys(value, required, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing required field '${key}'.`, { field: key });
  }
}

function string(value, label, { nullable = false, pattern = null } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string${nullable ? ' or null' : ''}.`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format.`);
}

function digest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(`${label} must be exactly 'sha256:' plus 64 lowercase hex characters.`);
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  string(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail(`${label} must be an RFC 3339 timestamp supplied by the caller.`);
  }
}

function integer(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be a safe integer >= ${minimum}.`);
}

function enumeration(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} must be one of: ${allowed.join(', ')}.`);
}

function stringArray(value, label, { digests = false, unique = true } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  value.forEach((entry, index) => digests ? digest(entry, `${label}[${index}]`) : string(entry, `${label}[${index}]`));
  if (unique && new Set(value).size !== value.length) fail(`${label} must not contain duplicates.`);
}

function identifier(value, prefix, label) {
  string(value, label);
  if (!new RegExp(`^${prefix}-[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$`).test(value)) {
    fail(`${label} must be a ${prefix}-prefixed identifier.`);
  }
}

function repositoryPath(value, label) {
  string(value, label);
  if (value.startsWith('/') || value.startsWith('./') || value.includes('\\') || value.endsWith('/')
      || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail(`${label} must be a canonical repository-relative path.`);
  }
}

function absolutePath(value, label) {
  string(value, label);
  let canonical;
  try { canonical = canonicalizeSgosAbsolutePath(value); } catch {
    canonical = null;
  }
  if (canonical !== value) {
    fail(`${label} must be a canonical absolute path using '/' separators.`);
  }
}

function principal(value, label) {
  exactKeys(value, ['id', 'kind', 'name', 'email', 'authoritySha256'], label);
  requireKeys(value, ['id', 'kind'], label);
  string(value.id, `${label}.id`);
  enumeration(value.kind, ['human', 'service', 'agent', 'system', 'external'], `${label}.kind`);
  if (value.name != null) string(value.name, `${label}.name`);
  if (value.email != null) string(value.email, `${label}.email`);
  if (value.authoritySha256 != null) digest(value.authoritySha256, `${label}.authoritySha256`);
}

function subject(value, label) {
  exactKeys(value, ['kind', 'id', 'revision', 'sha256'], label);
  requireKeys(value, ['kind', 'id'], label);
  string(value.kind, `${label}.kind`, { pattern: /^[a-z][a-z0-9-]*$/ });
  string(value.id, `${label}.id`);
  if (value.revision != null) string(value.revision, `${label}.revision`);
  if (value.sha256 != null) digest(value.sha256, `${label}.sha256`);
}

function normativeClause(value, label) {
  exactKeys(value, ['id', 'clauseId', 'statement', 'value', 'provenance', 'required', 'sourceRef', 'category', 'severity'], label);
  if (!value.id && !value.clauseId) fail(`${label} requires id or clauseId.`);
  if (value.id != null) string(value.id, `${label}.id`);
  if (value.clauseId != null) string(value.clauseId, `${label}.clauseId`);
  if (value.statement == null && value.value == null) fail(`${label} requires statement or value.`);
  if (value.statement != null) string(value.statement, `${label}.statement`);
  if (value.value != null) cloneJson(value.value, `${label}.value`);
  enumeration(value.provenance, INTENT_PROVENANCE, `${label}.provenance`);
  if (value.required != null && typeof value.required !== 'boolean') fail(`${label}.required must be boolean.`);
  if (value.sourceRef != null) string(value.sourceRef, `${label}.sourceRef`);
  if (value.category != null) string(value.category, `${label}.category`);
  if (value.severity != null) enumeration(value.severity, ['low', 'medium', 'high', 'critical'], `${label}.severity`);
}

function normativeArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  value.forEach((entry, index) => normativeClause(entry, `${label}[${index}]`));
}

function verifySelfHash(record, descriptor, requireHash) {
  if (!requireHash) return;
  digest(record[descriptor.hash], `${descriptor.kind}.${descriptor.hash}`);
  const expected = recordSelfSha256(record, descriptor.hash);
  if (record[descriptor.hash] !== expected) {
    fail(`${descriptor.kind}.${descriptor.hash} does not match the canonical record.`, {
      expected, received: record[descriptor.hash]
    });
  }
}

function validateBase(record, family, allowed, required, requireHash) {
  const descriptor = CONTRACTS[family];
  exactKeys(record, ['schemaVersion', 'kind', ...allowed, descriptor.hash], descriptor.kind);
  requireKeys(record, ['schemaVersion', 'kind', ...required, ...(requireHash ? [descriptor.hash] : [])], descriptor.kind);
  const storedVersion = record['schemaVersion'];
  if (storedVersion !== currentSchemaVersion(family)) fail(`${descriptor.kind}.schemaVersion is not current.`);
  if (record.kind !== descriptor.kind) fail(`${descriptor.kind}.kind must be '${descriptor.kind}'.`);
  verifySelfHash(record, descriptor, requireHash);
}

function createContract(family, source, validator, { prepare = (value) => value, identity = null } = {}) {
  const descriptor = CONTRACTS[family];
  const input = cloneJson(source);
  if (!plainObject(input)) fail(`${family} input must be an object.`);
  const suppliedVersion = input['schemaVersion'];
  if (suppliedVersion != null && suppliedVersion !== currentSchemaVersion(family)) {
    fail(`${family}.schemaVersion must be ${currentSchemaVersion(family)}.`);
  }
  if (input.kind != null && input.kind !== descriptor.kind) fail(`${family}.kind must be '${descriptor.kind}'.`);
  const suppliedHash = input[descriptor.hash];
  delete input[descriptor.hash];
  let record = prepare({ ...input, schemaVersion: currentSchemaVersion(family), kind: descriptor.kind });
  if (descriptor.id && record[descriptor.id] == null) {
    const basis = identity ? identity(record) : Object.fromEntries(Object.entries(record).filter(([key]) => key !== descriptor.id));
    record = { ...record, [descriptor.id]: deterministicSgosId(descriptor.prefix, basis) };
  }
  validator(record, false);
  record = { ...record, [descriptor.hash]: recordSelfSha256(record, descriptor.hash) };
  if (suppliedHash != null && suppliedHash !== record[descriptor.hash]) {
    fail(`${family}.${descriptor.hash} supplied by the caller is not canonical.`, {
      expected: record[descriptor.hash], received: suppliedHash
    });
  }
  validator(record, true);
  return freezeDeep(cloneJson(record));
}

function returnValidated(value, validator) {
  validator(value, true);
  return freezeDeep(cloneJson(value));
}

function validateIntentEnvelopeRecord(record, requireHash) {
  validateBase(record, 'intent-envelope', [
    'intentId', 'generation', 'principal', 'source', 'rawRef', 'rawSha256', 'attachments', 'capturedAt'
  ], ['intentId', 'generation', 'principal', 'source', 'rawRef', 'rawSha256', 'attachments', 'capturedAt'], requireHash);
  identifier(record.intentId, 'INT', 'intent-envelope.intentId');
  integer(record.generation, 'intent-envelope.generation', { minimum: 1 });
  principal(record.principal, 'intent-envelope.principal');
  exactKeys(record.source, ['kind', 'revision'], 'intent-envelope.source');
  requireKeys(record.source, ['kind', 'revision'], 'intent-envelope.source');
  enumeration(record.source.kind, INTENT_SOURCE_KINDS, 'intent-envelope.source.kind');
  if (record.source.revision !== null) string(record.source.revision, 'intent-envelope.source.revision');
  string(record.rawRef, 'intent-envelope.rawRef');
  digest(record.rawSha256, 'intent-envelope.rawSha256');
  if (!Array.isArray(record.attachments)) fail('intent-envelope.attachments must be an array.');
  record.attachments.forEach((attachment, index) => {
    const label = `intent-envelope.attachments[${index}]`;
    exactKeys(attachment, ['ref', 'sha256', 'mediaType'], label);
    requireKeys(attachment, ['ref', 'sha256', 'mediaType'], label);
    string(attachment.ref, `${label}.ref`);
    digest(attachment.sha256, `${label}.sha256`);
    string(attachment.mediaType, `${label}.mediaType`);
  });
  timestamp(record.capturedAt, 'intent-envelope.capturedAt');
}

export function createIntentEnvelope(value) {
  return createContract('intent-envelope', value, validateIntentEnvelopeRecord, {
    identity: (record) => ({ generation: record.generation, principal: record.principal, source: record.source, rawSha256: record.rawSha256 })
  });
}

export function validateIntentEnvelope(value) {
  return returnValidated(value, validateIntentEnvelopeRecord);
}

function validateIntentIrRecord(record, requireHash) {
  const arrays = [
    'outcomes', 'successCriteria', 'constraints', 'invariants', 'preferences', 'nonGoals',
    'assumptions', 'unknowns', 'contradictions', 'risks', 'evidenceExpectations',
    'authorityRequirements', 'budgets', 'domainCandidates', 'workTypeCandidates'
  ];
  validateBase(record, 'intent-ir', ['intentId', 'generation', 'objective', ...arrays, 'subjects'], [
    'intentId', 'generation', 'objective', ...arrays, 'subjects'
  ], requireHash);
  identifier(record.intentId, 'INT', 'intent-ir.intentId');
  integer(record.generation, 'intent-ir.generation', { minimum: 1 });
  exactKeys(record.objective, ['statement', 'provenance', 'sourceRef'], 'intent-ir.objective');
  requireKeys(record.objective, ['statement', 'provenance'], 'intent-ir.objective');
  string(record.objective.statement, 'intent-ir.objective.statement');
  enumeration(record.objective.provenance, INTENT_PROVENANCE, 'intent-ir.objective.provenance');
  if (record.objective.sourceRef != null) string(record.objective.sourceRef, 'intent-ir.objective.sourceRef');
  arrays.forEach((field) => normativeArray(record[field], `intent-ir.${field}`));
  if (!Array.isArray(record.subjects)) fail('intent-ir.subjects must be an array.');
  record.subjects.forEach((entry, index) => subject(entry, `intent-ir.subjects[${index}]`));
}

export function createIntentIr(value) {
  return createContract('intent-ir', value, validateIntentIrRecord, {
    identity: (record) => ({ generation: record.generation, objective: record.objective, subjects: record.subjects })
  });
}

export function validateIntentIr(value) {
  return returnValidated(value, validateIntentIrRecord);
}

function validateResourceContract(value, label) {
  exactKeys(value, ['reads', 'writes', 'devices', 'externalEffects'], label);
  requireKeys(value, ['reads', 'writes', 'devices', 'externalEffects'], label);
  for (const key of ['reads', 'writes', 'devices', 'externalEffects']) stringArray(value[key], `${label}.${key}`);
}

function validateWorkflowTask(value, label, keyedId = null) {
  exactKeys(value, [
    'id', 'taskId', 'kind', 'opcode', 'operation', 'dependsOn', 'resources', 'evidence',
    'authority', 'recovery', 'intentClauseIds', 'material', 'condition', 'body', 'items',
    'maximumIterations', 'subprocess', 'compensation', 'checkpoint', 'metadata', 'inputs',
    'outputs', 'timeoutMs', 'retry', 'policySnapshotSha256'
  ], label);
  requireKeys(value, ['kind'], label);
  const id = value.id ?? value.taskId ?? keyedId;
  string(id, `${label}.id`);
  if (keyedId && id !== keyedId) fail(`${label} ID must match its tasks-map key '${keyedId}'.`);
  enumeration(value.kind, WORKFLOW_CONSTRUCTS, `${label}.kind`);
  if (value.opcode != null) enumeration(value.opcode, GVM_OPCODES, `${label}.opcode`);
  if (value.operation != null) string(value.operation, `${label}.operation`, { pattern: /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/ });
  if (value.dependsOn != null) stringArray(value.dependsOn, `${label}.dependsOn`);
  if (value.resources != null) validateResourceContract(value.resources, `${label}.resources`);
  if (value.intentClauseIds != null) stringArray(value.intentClauseIds, `${label}.intentClauseIds`);
  if (value.material != null && typeof value.material !== 'boolean') fail(`${label}.material must be boolean.`);
  if (value.maximumIterations != null) integer(value.maximumIterations, `${label}.maximumIterations`, { minimum: 1 });
  if (value.timeoutMs != null) integer(value.timeoutMs, `${label}.timeoutMs`, { minimum: 1 });
  if (value.policySnapshotSha256 != null) digest(value.policySnapshotSha256, `${label}.policySnapshotSha256`);
  for (const field of ['evidence', 'authority', 'recovery', 'condition', 'body', 'items', 'subprocess', 'compensation', 'checkpoint', 'metadata', 'inputs', 'outputs', 'retry']) {
    if (value[field] != null) cloneJson(value[field], `${label}.${field}`);
  }
}

function validateIntentWorkflowMap(value, label) {
  exactKeys(value, ['clauses', 'tasks'], label);
  requireKeys(value, ['clauses', 'tasks'], label);
  for (const direction of ['clauses', 'tasks']) {
    object(value[direction], `${label}.${direction}`);
    for (const [id, links] of Object.entries(value[direction])) {
      string(id, `${label}.${direction} key`);
      if (!Array.isArray(links)) fail(`${label}.${direction}.${id} must be an array.`);
      links.forEach((link, index) => {
        exactKeys(link, ['kind', 'targetId', 'sourceId'], `${label}.${direction}.${id}[${index}]`);
        requireKeys(link, ['kind'], `${label}.${direction}.${id}[${index}]`);
        string(link.kind, `${label}.${direction}.${id}[${index}].kind`);
        if (link.targetId != null) string(link.targetId, `${label}.${direction}.${id}[${index}].targetId`);
        if (link.sourceId != null) string(link.sourceId, `${label}.${direction}.${id}[${index}].sourceId`);
        if (link.targetId == null && link.sourceId == null) fail(`${label}.${direction}.${id}[${index}] requires targetId or sourceId.`);
      });
    }
  }
}

function validateWorkflowIrRecord(record, requireHash) {
  validateBase(record, 'workflow-ir', [
    'apiVersion', 'workflowId', 'version', 'intentIrSha256', 'policySnapshotSha256', 'metadata', 'spec'
  ], ['apiVersion', 'workflowId', 'version', 'intentIrSha256', 'policySnapshotSha256', 'metadata', 'spec'], requireHash);
  if (record.apiVersion !== 'sflow/v1') fail("workflow-ir.apiVersion must be 'sflow/v1'.");
  identifier(record.workflowId, 'WFL', 'workflow-ir.workflowId');
  string(record.version, 'workflow-ir.version');
  digest(record.intentIrSha256, 'workflow-ir.intentIrSha256');
  digest(record.policySnapshotSha256, 'workflow-ir.policySnapshotSha256');
  exactKeys(record.metadata, ['id', 'version', 'domainPack', 'domainPackSha256', 'title'], 'workflow-ir.metadata');
  requireKeys(record.metadata, ['id', 'version', 'domainPack'], 'workflow-ir.metadata');
  string(record.metadata.id, 'workflow-ir.metadata.id');
  string(record.metadata.version, 'workflow-ir.metadata.version');
  string(record.metadata.domainPack, 'workflow-ir.metadata.domainPack');
  if (record.metadata.domainPackSha256 != null) digest(record.metadata.domainPackSha256, 'workflow-ir.metadata.domainPackSha256');
  if (record.metadata.title != null) string(record.metadata.title, 'workflow-ir.metadata.title');
  exactKeys(record.spec, [
    'inputs', 'tasks', 'joins', 'terminalConditions', 'budgets', 'recovery', 'evidence',
    'authority', 'storageRequirements', 'intentWorkflowMap'
  ], 'workflow-ir.spec');
  requireKeys(record.spec, [
    'inputs', 'tasks', 'joins', 'terminalConditions', 'budgets', 'recovery', 'evidence',
    'authority', 'storageRequirements'
  ], 'workflow-ir.spec');
  object(record.spec.inputs, 'workflow-ir.spec.inputs');
  if (Array.isArray(record.spec.tasks)) {
    record.spec.tasks.forEach((task, index) => validateWorkflowTask(task, `workflow-ir.spec.tasks[${index}]`));
  } else {
    object(record.spec.tasks, 'workflow-ir.spec.tasks');
    for (const [id, task] of Object.entries(record.spec.tasks)) validateWorkflowTask(task, `workflow-ir.spec.tasks.${id}`, id);
  }
  object(record.spec.joins, 'workflow-ir.spec.joins');
  if (!Array.isArray(record.spec.terminalConditions)) fail('workflow-ir.spec.terminalConditions must be an array.');
  for (const field of ['budgets', 'recovery', 'evidence', 'authority', 'storageRequirements']) object(record.spec[field], `workflow-ir.spec.${field}`);
  if (record.spec.intentWorkflowMap != null) validateIntentWorkflowMap(record.spec.intentWorkflowMap, 'workflow-ir.spec.intentWorkflowMap');
}

export function createWorkflowIr(value) {
  return createContract('workflow-ir', value, validateWorkflowIrRecord, {
    identity: (record) => ({ intentIrSha256: record.intentIrSha256, version: record.version, metadata: record.metadata, spec: record.spec })
  });
}

export function validateWorkflowIr(value) {
  return returnValidated(value, validateWorkflowIrRecord);
}

function validateWorkflowRatificationRecord(record, requireHash) {
  validateBase(record, 'workflow-ratification', [
    'ratificationId', 'intentIrSha256', 'workflowSha256', 'policySnapshotSha256',
    'registrySnapshotSha256', 'storageProfileSha256', 'packetSha256', 'decision',
    'principal', 'intentWorkflowMap', 'coverage', 'decidedAt'
  ], [
    'ratificationId', 'intentIrSha256', 'workflowSha256', 'policySnapshotSha256',
    'registrySnapshotSha256', 'storageProfileSha256', 'packetSha256', 'decision',
    'principal', 'decidedAt'
  ], requireHash);
  identifier(record.ratificationId, 'RAT', 'workflow-ratification.ratificationId');
  for (const field of [
    'intentIrSha256', 'workflowSha256', 'policySnapshotSha256',
    'registrySnapshotSha256', 'storageProfileSha256', 'packetSha256'
  ]) digest(record[field], `workflow-ratification.${field}`);
  enumeration(record.decision, ['ratified', 'approved', 'rejected', 'changes-requested'], 'workflow-ratification.decision');
  principal(record.principal, 'workflow-ratification.principal');
  if (record.intentWorkflowMap != null) validateIntentWorkflowMap(record.intentWorkflowMap, 'workflow-ratification.intentWorkflowMap');
  if (record.coverage != null) validateIntentWorkflowMap(record.coverage, 'workflow-ratification.coverage');
  timestamp(record.decidedAt, 'workflow-ratification.decidedAt');
}

export function createWorkflowRatification(value) {
  return createContract('workflow-ratification', value, validateWorkflowRatificationRecord, {
    identity: (record) => ({ workflowSha256: record.workflowSha256, packetSha256: record.packetSha256, decision: record.decision, principal: record.principal })
  });
}

export function validateWorkflowRatification(value) {
  return returnValidated(value, validateWorkflowRatificationRecord);
}

function validatePolicySnapshotRecord(record, requireHash) {
  validateBase(record, 'policy-snapshot', ['policyId', 'authorityRevision', ...POLICY_DIGEST_FIELDS], [
    'policyId', 'authorityRevision', ...POLICY_DIGEST_FIELDS
  ], requireHash);
  identifier(record.policyId, 'POL', 'policy-snapshot.policyId');
  string(record.authorityRevision, 'policy-snapshot.authorityRevision');
  POLICY_DIGEST_FIELDS.forEach((field) => digest(record[field], `policy-snapshot.${field}`));
}

export function createPolicySnapshot(value) {
  return createContract('policy-snapshot', value, validatePolicySnapshotRecord, {
    identity: (record) => Object.fromEntries(['authorityRevision', ...POLICY_DIGEST_FIELDS].map((field) => [field, record[field]]))
  });
}

export function validatePolicySnapshot(value) {
  return returnValidated(value, validatePolicySnapshotRecord);
}

export function policyComponentSha256(value) {
  return sha256({ kind: 'policy-component', value: cloneJson(value) });
}

const CANDIDATE_OPERATIONS = Object.freeze(['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed']);
const CANDIDATE_TYPES = Object.freeze(['file', 'symlink', 'directory']);
const CANDIDATE_MODES = Object.freeze(['100644', '100755', '120000', '040000']);

function validateCandidateResource(value, label) {
  exactKeys(value, ['path', 'type', 'mode', 'contentSha256', 'operation', 'renameFrom', 'renameTo', 'deletion'], label);
  requireKeys(value, ['path', 'type', 'mode', 'contentSha256', 'operation', 'renameFrom', 'renameTo', 'deletion'], label);
  repositoryPath(value.path, `${label}.path`);
  enumeration(value.type, CANDIDATE_TYPES, `${label}.type`);
  if (value.mode !== null) enumeration(value.mode, CANDIDATE_MODES, `${label}.mode`);
  if (value.contentSha256 !== null) digest(value.contentSha256, `${label}.contentSha256`);
  enumeration(value.operation, CANDIDATE_OPERATIONS, `${label}.operation`);
  if (value.renameFrom !== null) repositoryPath(value.renameFrom, `${label}.renameFrom`);
  if (value.renameTo !== null) repositoryPath(value.renameTo, `${label}.renameTo`);
  if (typeof value.deletion !== 'boolean') fail(`${label}.deletion must be boolean.`);
  if (value.operation === 'deleted') {
    if (!value.deletion || value.contentSha256 !== null || value.mode !== null) fail(`${label} deletion must have deletion=true and null contentSha256/mode.`);
  } else if (value.deletion || value.contentSha256 === null || value.mode === null) {
    fail(`${label} non-deletion must carry contentSha256/mode and deletion=false.`);
  }
  if (value.operation === 'renamed') {
    if (value.renameFrom === null || value.renameTo === null || value.path !== value.renameTo) fail(`${label} rename must name both endpoints and path must equal renameTo.`);
  } else if (value.renameFrom !== null || value.renameTo !== null) {
    fail(`${label} rename endpoints are only legal for operation='renamed'.`);
  }
  if ((value.type === 'symlink') !== (value.mode === '120000') && value.operation !== 'deleted') {
    fail(`${label} symlink type and mode 120000 must agree.`);
  }
}

function candidateResourceOrder(left, right) {
  return compareSgosCodePoints(left.path, right.path)
    || compareSgosCodePoints(left.operation, right.operation)
    || compareSgosCodePoints(left.renameFrom, right.renameFrom);
}

export function candidateManifestSha256(resources) {
  const manifest = cloneJson(resources);
  if (!Array.isArray(manifest)) fail('Candidate resources must be an array.');
  manifest.forEach((entry, index) => validateCandidateResource(entry, `candidate-manifest.resources[${index}]`));
  const sorted = [...manifest].sort(candidateResourceOrder);
  return sha256({ schemaVersion: 1, kind: 'candidate-manifest', resources: sorted });
}

function prepareCandidate(record) {
  if (!Array.isArray(record.resources)) fail('candidate-snapshot.resources must be an array.');
  const resources = [...record.resources].sort(candidateResourceOrder);
  resources.forEach((entry, index) => validateCandidateResource(entry, `candidate-snapshot.resources[${index}]`));
  if (new Set(resources.map((entry) => entry.path)).size !== resources.length) fail('candidate-snapshot.resources contains duplicate paths.');
  const manifestSha256 = candidateManifestSha256(resources);
  const snapshotSha256 = sha256({
    kind: 'candidate-logical-snapshot', subject: record.subject,
    baselineSnapshotSha256: record.baseline?.snapshotSha256, manifestSha256
  });
  if (record.candidate != null) {
    exactKeys(record.candidate, ['snapshotSha256', 'manifestSha256'], 'candidate-snapshot.candidate');
    if (record.candidate.manifestSha256 != null && record.candidate.manifestSha256 !== manifestSha256) fail('candidate-snapshot.candidate.manifestSha256 is not canonical.');
    if (record.candidate.snapshotSha256 != null && record.candidate.snapshotSha256 !== snapshotSha256) fail('candidate-snapshot.candidate.snapshotSha256 is not canonical.');
  }
  return { ...record, resources, candidate: { snapshotSha256, manifestSha256 } };
}

function validateCandidateSnapshotRecord(record, requireHash) {
  validateBase(record, 'candidate-snapshot', [
    'candidateId', 'subject', 'baseline', 'candidate', 'resources', 'createdBy', 'createdAt'
  ], ['candidateId', 'subject', 'baseline', 'candidate', 'resources', 'createdBy', 'createdAt'], requireHash);
  identifier(record.candidateId, 'CAN', 'candidate-snapshot.candidateId');
  subject(record.subject, 'candidate-snapshot.subject');
  exactKeys(record.baseline, ['revision', 'snapshotSha256'], 'candidate-snapshot.baseline');
  requireKeys(record.baseline, ['revision', 'snapshotSha256'], 'candidate-snapshot.baseline');
  string(record.baseline.revision, 'candidate-snapshot.baseline.revision');
  digest(record.baseline.snapshotSha256, 'candidate-snapshot.baseline.snapshotSha256');
  exactKeys(record.candidate, ['snapshotSha256', 'manifestSha256'], 'candidate-snapshot.candidate');
  requireKeys(record.candidate, ['snapshotSha256', 'manifestSha256'], 'candidate-snapshot.candidate');
  digest(record.candidate.snapshotSha256, 'candidate-snapshot.candidate.snapshotSha256');
  digest(record.candidate.manifestSha256, 'candidate-snapshot.candidate.manifestSha256');
  if (!Array.isArray(record.resources)) fail('candidate-snapshot.resources must be an array.');
  record.resources.forEach((entry, index) => validateCandidateResource(entry, `candidate-snapshot.resources[${index}]`));
  if (record.resources.some((entry, index) => index && candidateResourceOrder(record.resources[index - 1], entry) > 0)) fail('candidate-snapshot.resources must be canonically sorted.');
  if (candidateManifestSha256(record.resources) !== record.candidate.manifestSha256) fail('candidate-snapshot manifest digest does not match resources.');
  const snapshot = sha256({
    kind: 'candidate-logical-snapshot', subject: record.subject,
    baselineSnapshotSha256: record.baseline.snapshotSha256,
    manifestSha256: record.candidate.manifestSha256
  });
  if (snapshot !== record.candidate.snapshotSha256) fail('candidate-snapshot logical snapshot digest does not match its manifest and baseline.');
  principal(record.createdBy, 'candidate-snapshot.createdBy');
  timestamp(record.createdAt, 'candidate-snapshot.createdAt');
}

export function createCandidateSnapshot(value) {
  return createContract('candidate-snapshot', value, validateCandidateSnapshotRecord, {
    prepare: prepareCandidate,
    identity: (record) => ({ subject: record.subject, baseline: record.baseline, candidate: record.candidate, resources: record.resources })
  });
}

export function validateCandidateSnapshot(value) {
  return returnValidated(value, validateCandidateSnapshotRecord);
}

function validateProcessBindingRecord(record, requireHash) {
  validateBase(record, 'process-binding', [
    'processId', 'subjectId', 'subjectAuthority', 'configurationAuthority', 'repositoryIdentity', 'gitCommonDirectory',
    'worktreeGitDirectory', 'canonicalWorktreeRoot', 'branch', 'baselineRevision',
    'expectedProcessRevision'
  ], [
    'processId', 'subjectId', 'subjectAuthority', 'configurationAuthority', 'repositoryIdentity', 'gitCommonDirectory',
    'worktreeGitDirectory', 'canonicalWorktreeRoot', 'branch', 'baselineRevision',
    'expectedProcessRevision'
  ], requireHash);
  identifier(record.processId, 'PROC', 'process-binding.processId');
  string(record.subjectId, 'process-binding.subjectId');
  if (record.subjectAuthority !== null) {
    exactKeys(record.subjectAuthority, [
      'kind', 'subjectId', 'revision', 'path', 'blobSha256', 'stateSha256'
    ], 'process-binding.subjectAuthority');
    requireKeys(record.subjectAuthority, [
      'kind', 'subjectId', 'revision', 'path', 'blobSha256', 'stateSha256'
    ], 'process-binding.subjectAuthority');
    if (record.subjectAuthority.kind !== 'governed-story-baseline') {
      fail("process-binding.subjectAuthority.kind must be 'governed-story-baseline'.");
    }
    string(record.subjectAuthority.subjectId, 'process-binding.subjectAuthority.subjectId');
    string(record.subjectAuthority.revision, 'process-binding.subjectAuthority.revision', {
      pattern: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
    });
    repositoryPath(record.subjectAuthority.path, 'process-binding.subjectAuthority.path');
    digest(record.subjectAuthority.blobSha256, 'process-binding.subjectAuthority.blobSha256');
    digest(record.subjectAuthority.stateSha256, 'process-binding.subjectAuthority.stateSha256');
    if (record.subjectAuthority.subjectId !== record.subjectId
        || record.subjectAuthority.revision !== record.baselineRevision) {
      fail('process-binding.subjectAuthority must identify the bound subject and baseline revision.');
    }
  }
  configurationAuthority(record.configurationAuthority, 'process-binding.configurationAuthority', {
    nullable: true
  });
  string(record.repositoryIdentity, 'process-binding.repositoryIdentity');
  absolutePath(record.gitCommonDirectory, 'process-binding.gitCommonDirectory');
  absolutePath(record.worktreeGitDirectory, 'process-binding.worktreeGitDirectory');
  absolutePath(record.canonicalWorktreeRoot, 'process-binding.canonicalWorktreeRoot');
  string(record.branch, 'process-binding.branch');
  string(record.baselineRevision, 'process-binding.baselineRevision');
  integer(record.expectedProcessRevision, 'process-binding.expectedProcessRevision');
}

export function createProcessBinding(value) {
  return createContract('process-binding', value, validateProcessBindingRecord);
}

export function validateProcessBinding(value) {
  return returnValidated(value, validateProcessBindingRecord);
}

function validateTaskTemplate(value, label) {
  exactKeys(value, [
    'id', 'taskTemplateId', 'opcode', 'operation', 'dependsOn', 'resources', 'evidence',
    'authority', 'recovery', 'intentClauseIds', 'inputs', 'outputs', 'retry', 'timeoutMs',
    'policySnapshotSha256', 'material', 'metadata', 'taskTemplateSha256'
  ], label);
  if (!value.id && !value.taskTemplateId) fail(`${label} requires id or taskTemplateId.`);
  if (value.id != null) string(value.id, `${label}.id`);
  if (value.taskTemplateId != null) string(value.taskTemplateId, `${label}.taskTemplateId`);
  enumeration(value.opcode, GVM_OPCODES, `${label}.opcode`);
  if (value.operation != null) string(value.operation, `${label}.operation`, { pattern: /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/ });
  if (value.dependsOn != null) stringArray(value.dependsOn, `${label}.dependsOn`);
  if (value.resources != null) validateResourceContract(value.resources, `${label}.resources`);
  if (value.intentClauseIds != null) stringArray(value.intentClauseIds, `${label}.intentClauseIds`);
  if (value.timeoutMs != null) integer(value.timeoutMs, `${label}.timeoutMs`, { minimum: 1 });
  if (value.policySnapshotSha256 != null) digest(value.policySnapshotSha256, `${label}.policySnapshotSha256`);
  if (value.taskTemplateSha256 != null) digest(value.taskTemplateSha256, `${label}.taskTemplateSha256`);
  if (value.material != null && typeof value.material !== 'boolean') fail(`${label}.material must be boolean.`);
  for (const field of ['evidence', 'authority', 'recovery', 'inputs', 'outputs', 'retry', 'metadata']) {
    if (value[field] != null) cloneJson(value[field], `${label}.${field}`);
  }
}

function validateGvmProgramRecord(record, requireHash) {
  validateBase(record, 'gvm-program', [
    'programId', 'intentIrSha256', 'workflowSha256', 'ratificationSha256',
    'policySnapshotSha256', 'registrySnapshotSha256', 'storageProfileSha256',
    'taskTemplates', 'edges', 'joins', 'budgets', 'recoveryPolicy', 'terminalConditions', 'compiler'
  ], [
    'programId', 'intentIrSha256', 'workflowSha256', 'ratificationSha256',
    'policySnapshotSha256', 'registrySnapshotSha256', 'storageProfileSha256',
    'taskTemplates', 'edges', 'joins', 'budgets', 'recoveryPolicy', 'terminalConditions', 'compiler'
  ], requireHash);
  identifier(record.programId, 'PRG', 'gvm-program.programId');
  for (const field of ['intentIrSha256', 'workflowSha256', 'ratificationSha256', 'policySnapshotSha256', 'registrySnapshotSha256', 'storageProfileSha256']) digest(record[field], `gvm-program.${field}`);
  if (!Array.isArray(record.taskTemplates)) fail('gvm-program.taskTemplates must be an array.');
  record.taskTemplates.forEach((entry, index) => validateTaskTemplate(entry, `gvm-program.taskTemplates[${index}]`));
  if (!Array.isArray(record.edges)) fail('gvm-program.edges must be an array.');
  record.edges.forEach((edge, index) => {
    const label = `gvm-program.edges[${index}]`;
    exactKeys(edge, ['from', 'to', 'condition'], label);
    requireKeys(edge, ['from', 'to'], label);
    string(edge.from, `${label}.from`);
    string(edge.to, `${label}.to`);
    if (edge.condition != null) cloneJson(edge.condition, `${label}.condition`);
  });
  if (!Array.isArray(record.joins) && !plainObject(record.joins)) fail('gvm-program.joins must be an array or object map.');
  object(record.budgets, 'gvm-program.budgets');
  object(record.recoveryPolicy, 'gvm-program.recoveryPolicy');
  if (!Array.isArray(record.terminalConditions)) fail('gvm-program.terminalConditions must be an array.');
  exactKeys(record.compiler, ['id', 'version', 'sourceSha256'], 'gvm-program.compiler');
  requireKeys(record.compiler, ['id', 'version'], 'gvm-program.compiler');
  string(record.compiler.id, 'gvm-program.compiler.id');
  string(record.compiler.version, 'gvm-program.compiler.version');
  if (record.compiler.sourceSha256 != null) digest(record.compiler.sourceSha256, 'gvm-program.compiler.sourceSha256');
}

export function createGvmProgram(value) {
  return createContract('gvm-program', value, validateGvmProgramRecord, {
    identity: (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !['programId', 'schemaVersion', 'kind'].includes(key)))
  });
}

export function validateGvmProgram(value) {
  return returnValidated(value, validateGvmProgramRecord);
}

function validateTaskInstance(value, label, keyedId) {
  exactKeys(value, [
    'taskInstanceId', 'taskTemplateId', 'state', 'predecessorTaskInstanceIds', 'inputRefs',
    'outputRefs', 'attemptIds', 'receiptSha256', 'invalidatedBy', 'revision'
  ], label);
  requireKeys(value, [
    'taskInstanceId', 'taskTemplateId', 'state', 'predecessorTaskInstanceIds', 'inputRefs',
    'outputRefs', 'attemptIds', 'receiptSha256', 'invalidatedBy', 'revision'
  ], label);
  string(value.taskInstanceId, `${label}.taskInstanceId`);
  if (keyedId !== value.taskInstanceId) fail(`${label}.taskInstanceId must match map key '${keyedId}'.`);
  string(value.taskTemplateId, `${label}.taskTemplateId`);
  enumeration(value.state, TASK_STATES, `${label}.state`);
  for (const field of ['predecessorTaskInstanceIds', 'inputRefs', 'outputRefs', 'attemptIds']) stringArray(value[field], `${label}.${field}`);
  if (value.receiptSha256 !== null) digest(value.receiptSha256, `${label}.receiptSha256`);
  if (value.invalidatedBy !== null) string(value.invalidatedBy, `${label}.invalidatedBy`);
  integer(value.revision, `${label}.revision`);
  if (value.state === 'succeeded' && value.receiptSha256 === null) fail(`${label} cannot be succeeded without receiptSha256.`);
  if (value.state !== 'succeeded' && value.receiptSha256 !== null) fail(`${label} cannot retain receiptSha256 outside succeeded state.`);
}

function validateExecutionAdmissionSource(value, label) {
  exactKeys(value, [
    'kind', 'ref', 'commit', 'sourceCommit', 'path', 'blobSha256',
    'configurationAuthority'
  ], label);
  requireKeys(value, [
    'kind', 'ref', 'commit', 'sourceCommit', 'path', 'blobSha256',
    'configurationAuthority'
  ], label);
  enumeration(value.kind, ['approved-configuration-ref', 'verified-state-mirror'], `${label}.kind`);
  string(value.ref, `${label}.ref`, { pattern: /^refs\/(?:heads|remotes)\/[A-Za-z0-9._/-]+$/ });
  string(value.commit, `${label}.commit`, { pattern: /^[a-f0-9]{40,64}$/ });
  string(value.sourceCommit, `${label}.sourceCommit`, { pattern: /^[a-f0-9]{40,64}$/ });
  repositoryPath(value.path, `${label}.path`);
  digest(value.blobSha256, `${label}.blobSha256`);
  configurationAuthority(value.configurationAuthority, `${label}.configurationAuthority`);
}

function validateExecutionAdmission(value, label) {
  exactKeys(value, ['admitted', 'programId', 'programSha256', 'provenance', 'safety'], label);
  requireKeys(value, ['admitted', 'programId', 'programSha256', 'provenance', 'safety'], label);
  if (value.admitted !== true) fail(`${label}.admitted must be true.`);
  identifier(value.programId, 'PRG', `${label}.programId`);
  digest(value.programSha256, `${label}.programSha256`);

  exactKeys(value.provenance, [
    'method', 'programSha256', 'intentIrSha256', 'workflowSha256',
    'ratificationSha256', 'source'
  ], `${label}.provenance`);
  requireKeys(value.provenance, [
    'method', 'programSha256', 'ratificationSha256', 'source'
  ], `${label}.provenance`);
  enumeration(value.provenance.method, [
    'approved-program-authority', 'approved-authority+deterministic-recompilation'
  ], `${label}.provenance.method`);
  digest(value.provenance.programSha256, `${label}.provenance.programSha256`);
  digest(value.provenance.ratificationSha256, `${label}.provenance.ratificationSha256`);
  validateExecutionAdmissionSource(value.provenance.source, `${label}.provenance.source`);
  if (value.provenance.method === 'approved-authority+deterministic-recompilation') {
    digest(value.provenance.intentIrSha256, `${label}.provenance.intentIrSha256`);
    digest(value.provenance.workflowSha256, `${label}.provenance.workflowSha256`);
  } else if (value.provenance.intentIrSha256 != null || value.provenance.workflowSha256 != null) {
    fail(`${label}.provenance cannot claim recompilation digests without recompilation.`);
  }

  exactKeys(value.safety, [
    'safe', 'programId', 'programSha256', 'compiler', 'graph', 'registry'
  ], `${label}.safety`);
  requireKeys(value.safety, [
    'safe', 'programId', 'programSha256', 'compiler', 'graph', 'registry'
  ], `${label}.safety`);
  if (value.safety.safe !== true) fail(`${label}.safety.safe must be true.`);
  identifier(value.safety.programId, 'PRG', `${label}.safety.programId`);
  digest(value.safety.programSha256, `${label}.safety.programSha256`);
  exactKeys(value.safety.compiler, ['id', 'version'], `${label}.safety.compiler`);
  requireKeys(value.safety.compiler, ['id', 'version'], `${label}.safety.compiler`);
  string(value.safety.compiler.id, `${label}.safety.compiler.id`);
  string(value.safety.compiler.version, `${label}.safety.compiler.version`);
  exactKeys(value.safety.graph, [
    'taskCount', 'edgeCount', 'roots', 'terminalTaskIds', 'topologicalOrder'
  ], `${label}.safety.graph`);
  requireKeys(value.safety.graph, [
    'taskCount', 'edgeCount', 'roots', 'terminalTaskIds', 'topologicalOrder'
  ], `${label}.safety.graph`);
  integer(value.safety.graph.taskCount, `${label}.safety.graph.taskCount`);
  integer(value.safety.graph.edgeCount, `${label}.safety.graph.edgeCount`);
  for (const field of ['roots', 'terminalTaskIds', 'topologicalOrder']) {
    stringArray(value.safety.graph[field], `${label}.safety.graph.${field}`);
  }
  exactKeys(value.safety.registry, [
    'verified', 'registrySnapshotSha256'
  ], `${label}.safety.registry`);
  requireKeys(value.safety.registry, [
    'verified', 'registrySnapshotSha256'
  ], `${label}.safety.registry`);
  if (typeof value.safety.registry.verified !== 'boolean') {
    fail(`${label}.safety.registry.verified must be boolean.`);
  }
  digest(value.safety.registry.registrySnapshotSha256,
    `${label}.safety.registry.registrySnapshotSha256`);
  if (value.programId !== value.safety.programId
      || value.programSha256 !== value.safety.programSha256
      || value.programSha256 !== value.provenance.programSha256) {
    fail(`${label} Program identities must agree.`);
  }
}

function validateProcessAuthorityBinding(value, label) {
  exactKeys(value, [
    'kind', 'subjectId', 'subjectAuthority', 'branch', 'baselineRevision',
    'baselineSnapshotSha256', 'authority', 'configurationAuthority', 'humanAuthorityRequirements',
    'executionAdmission'
  ], label);
  requireKeys(value, [
    'kind', 'subjectId', 'subjectAuthority', 'branch', 'baselineRevision',
    'baselineSnapshotSha256', 'authority', 'configurationAuthority', 'humanAuthorityRequirements',
    'executionAdmission'
  ], label);
  enumeration(value.kind, ['story', 'repository'], `${label}.kind`);
  string(value.subjectId, `${label}.subjectId`);
  string(value.branch, `${label}.branch`);
  string(value.baselineRevision, `${label}.baselineRevision`, { pattern: /^[a-f0-9]{40,64}$/ });
  digest(value.baselineSnapshotSha256, `${label}.baselineSnapshotSha256`);
  const storyProcess = value.kind === 'story';
  const expectedAuthority = storyProcess
    ? 'existing-story-lifecycle'
    : 'existing-repository-baseline';
  if (value.authority !== expectedAuthority) {
    fail(`${label}.authority must be '${expectedAuthority}' for a ${value.kind} Process.`);
  }
  configurationAuthority(value.configurationAuthority, `${label}.configurationAuthority`);
  if (!Array.isArray(value.humanAuthorityRequirements)) {
    fail(`${label}.humanAuthorityRequirements must be an array.`);
  }
  value.humanAuthorityRequirements.forEach((entry, index) => {
    const authorityLabel = `${label}.humanAuthorityRequirements[${index}]`;
    exactKeys(entry, [
      'kind', 'id', 'minimumAssurance', 'authoritySha256'
    ], authorityLabel);
    requireKeys(entry, [
      'kind', 'id', 'minimumAssurance', 'authoritySha256'
    ], authorityLabel);
    for (const field of ['kind', 'id']) {
      string(entry[field], `${authorityLabel}.${field}`);
    }
    if (entry.minimumAssurance != null) {
      string(entry.minimumAssurance, `${authorityLabel}.minimumAssurance`);
    }
    digest(entry.authoritySha256, `${authorityLabel}.authoritySha256`);
  });
  if (value.subjectAuthority === null) {
    if (storyProcess) fail(`${label}.subjectAuthority is required for a Story Process.`);
  } else {
    if (!storyProcess) fail(`${label}.subjectAuthority must be null for a repository Process.`);
    exactKeys(value.subjectAuthority, [
      'kind', 'subjectId', 'revision', 'path', 'blobSha256', 'stateSha256'
    ], `${label}.subjectAuthority`);
    requireKeys(value.subjectAuthority, [
      'kind', 'subjectId', 'revision', 'path', 'blobSha256', 'stateSha256'
    ], `${label}.subjectAuthority`);
    if (value.subjectAuthority.kind !== 'governed-story-baseline') {
      fail(`${label}.subjectAuthority.kind must be 'governed-story-baseline'.`);
    }
    string(value.subjectAuthority.subjectId, `${label}.subjectAuthority.subjectId`);
    string(value.subjectAuthority.revision, `${label}.subjectAuthority.revision`, {
      pattern: /^[a-f0-9]{40,64}$/
    });
    repositoryPath(value.subjectAuthority.path, `${label}.subjectAuthority.path`);
    digest(value.subjectAuthority.blobSha256, `${label}.subjectAuthority.blobSha256`);
    digest(value.subjectAuthority.stateSha256, `${label}.subjectAuthority.stateSha256`);
    if (value.subjectAuthority.subjectId !== value.subjectId
        || value.subjectAuthority.revision !== value.baselineRevision) {
      fail(`${label}.subjectAuthority must identify the bound subject and baseline revision.`);
    }
  }
  validateExecutionAdmission(value.executionAdmission, `${label}.executionAdmission`);
  if (value.executionAdmission.provenance.source.configurationAuthority.kind
      !== value.configurationAuthority.kind
      || value.executionAdmission.provenance.source.configurationAuthority.ref
        !== value.configurationAuthority.ref
      || value.executionAdmission.provenance.source.configurationAuthority.commit
        !== value.configurationAuthority.commit
      || value.executionAdmission.provenance.source.configurationAuthority.workflowBlobSha256
        !== value.configurationAuthority.workflowBlobSha256) {
    fail(`${label}.executionAdmission must use the bound configuration authority.`);
  }
}

function validateGvmProcessRecord(record, requireHash) {
  validateBase(record, 'gvm-process', [
    'processId', 'programSha256', 'policySnapshotSha256', 'processBindingSha256', 'status',
    'taskInstances', 'activeExecutions', 'openHumanRequests', 'activeLeases',
    'currentCheckpointSha256', 'controlEventSha256', 'recordIndexSha256', 'processRevision', 'authorityBinding', 'taskContractSha256',
    'createdAt', 'updatedAt'
  ], [
    'processId', 'programSha256', 'policySnapshotSha256', 'processBindingSha256', 'status',
    'taskInstances', 'activeExecutions', 'openHumanRequests', 'activeLeases',
    'currentCheckpointSha256', 'controlEventSha256', 'recordIndexSha256', 'processRevision', 'authorityBinding', 'taskContractSha256',
    'createdAt', 'updatedAt'
  ], requireHash);
  identifier(record.processId, 'PROC', 'gvm-process.processId');
  for (const field of ['programSha256', 'policySnapshotSha256', 'processBindingSha256']) digest(record[field], `gvm-process.${field}`);
  enumeration(record.status, PROCESS_STATES, 'gvm-process.status');
  object(record.taskInstances, 'gvm-process.taskInstances');
  for (const [id, instance] of Object.entries(record.taskInstances)) validateTaskInstance(instance, `gvm-process.taskInstances.${id}`, id);
  stringArray(record.activeExecutions, 'gvm-process.activeExecutions');
  stringArray(record.openHumanRequests, 'gvm-process.openHumanRequests', { digests: true });
  stringArray(record.activeLeases, 'gvm-process.activeLeases');
  if (record.currentCheckpointSha256 !== null) digest(record.currentCheckpointSha256, 'gvm-process.currentCheckpointSha256');
  if (record.controlEventSha256 !== null) digest(record.controlEventSha256, 'gvm-process.controlEventSha256');
  if (record.recordIndexSha256 !== null) digest(record.recordIndexSha256, 'gvm-process.recordIndexSha256');
  integer(record.processRevision, 'gvm-process.processRevision');
  validateProcessAuthorityBinding(record.authorityBinding, 'gvm-process.authorityBinding');
  digest(record.taskContractSha256, 'gvm-process.taskContractSha256');
  timestamp(record.createdAt, 'gvm-process.createdAt');
  timestamp(record.updatedAt, 'gvm-process.updatedAt');
}

export function createGvmProcess(value) {
  return createContract('gvm-process', value, validateGvmProcessRecord, {
    prepare: (record) => ({
      ...record,
      controlEventSha256: record.controlEventSha256 ?? null,
      recordIndexSha256: record.recordIndexSha256 ?? null
    }),
    identity: (record) => ({ programSha256: record.programSha256, processBindingSha256: record.processBindingSha256, createdAt: record.createdAt ?? null })
  });
}

export function validateGvmProcess(value) {
  return returnValidated(value, validateGvmProcessRecord);
}

export const SGOS_RECORD_INDEX_FAMILIES = Object.freeze([
  'action-evidence', 'candidate-snapshot', 'gvm-checkpoint', 'gvm-program',
  'gvm-task-attempt', 'gvm-task-receipt', 'human-request', 'human-response',
  'process-binding'
]);

export const MAXIMUM_SGOS_RECORD_INDEX_DELTA =
  SGOS_INSTALLED_LIMITS.maximumRecordIndexDeltaEntries;
export const MAXIMUM_SGOS_PROCESS_RECORD_COUNT = SGOS_INSTALLED_LIMITS.maximumProcessRecords;
export const MAXIMUM_SGOS_PROCESS_RECORD_BYTES = SGOS_INSTALLED_LIMITS.maximumProcessRecordBytes;
export const MAXIMUM_SGOS_RECORD_BYTES = SGOS_INSTALLED_LIMITS.maximumRecordBytes;

function sgosRecordIndexEntryKey(entry) {
  return [
    entry.family, entry.recordSha256, entry.attemptId ?? '', entry.taskInstanceId ?? ''
  ].join('\u0000');
}

function validateSgosRecordIndexRecord(record, requireHash) {
  validateBase(record, 'sgos-record-index', [
    'processId', 'sequence', 'priorIndexSha256', 'delta', 'familyCounts',
    'totalRecordCount', 'totalBytes'
  ], [
    'processId', 'sequence', 'priorIndexSha256', 'delta', 'familyCounts',
    'totalRecordCount', 'totalBytes'
  ], requireHash);
  identifier(record.processId, 'PROC', 'sgos-record-index.processId');
  integer(record.sequence, 'sgos-record-index.sequence');
  if (record.priorIndexSha256 !== null) {
    digest(record.priorIndexSha256, 'sgos-record-index.priorIndexSha256');
  }
  if ((record.sequence === 0) !== (record.priorIndexSha256 === null)) {
    fail('sgos-record-index sequence 0 must be the sole null-predecessor genesis index.');
  }
  if (!Array.isArray(record.delta)) fail('sgos-record-index.delta must be an array.');
  if (record.delta.length > MAXIMUM_SGOS_RECORD_INDEX_DELTA) {
    fail(`sgos-record-index.delta exceeds the ${MAXIMUM_SGOS_RECORD_INDEX_DELTA}-record transition bound.`);
  }
  const allowedFamilies = new Set(SGOS_RECORD_INDEX_FAMILIES);
  const deltaCounts = new Map();
  let deltaBytes = 0;
  let priorKey = null;
  const uniqueRecords = new Set();
  record.delta.forEach((entry, index) => {
    const label = `sgos-record-index.delta[${index}]`;
    exactKeys(entry, ['family', 'recordSha256', 'attemptId', 'taskInstanceId', 'bytes'], label);
    requireKeys(entry, ['family', 'recordSha256', 'bytes'], label);
    enumeration(entry.family, SGOS_RECORD_INDEX_FAMILIES, `${label}.family`);
    digest(entry.recordSha256, `${label}.recordSha256`);
    if (Object.hasOwn(entry, 'attemptId')) identifier(entry.attemptId, 'ATT', `${label}.attemptId`);
    if (Object.hasOwn(entry, 'taskInstanceId')) string(entry.taskInstanceId, `${label}.taskInstanceId`);
    integer(entry.bytes, `${label}.bytes`, { minimum: 1 });
    if (entry.bytes > MAXIMUM_SGOS_RECORD_BYTES) {
      fail(`${label}.bytes exceeds the installed ${MAXIMUM_SGOS_RECORD_BYTES}-byte record bound.`);
    }
    const identity = `${entry.family}\u0000${entry.recordSha256}`;
    if (uniqueRecords.has(identity)) fail('sgos-record-index.delta must not contain duplicate records.');
    uniqueRecords.add(identity);
    const key = sgosRecordIndexEntryKey(entry);
    if (priorKey !== null && compareSgosCodePoints(priorKey, key) >= 0) {
      fail('sgos-record-index.delta must be strictly sorted by family and record identity.');
    }
    priorKey = key;
    deltaCounts.set(entry.family, (deltaCounts.get(entry.family) ?? 0) + 1);
    deltaBytes += entry.bytes;
    if (!Number.isSafeInteger(deltaBytes)) fail('sgos-record-index.delta byte total exceeds safe integer range.');
  });
  object(record.familyCounts, 'sgos-record-index.familyCounts');
  let countedRecords = 0;
  for (const [family, count] of Object.entries(record.familyCounts)) {
    if (!allowedFamilies.has(family)) fail(`sgos-record-index.familyCounts contains unknown family '${family}'.`);
    integer(count, `sgos-record-index.familyCounts.${family}`, { minimum: 1 });
    if (count < (deltaCounts.get(family) ?? 0)) {
      fail(`sgos-record-index.familyCounts.${family} cannot be smaller than the current delta.`);
    }
    countedRecords += count;
    if (!Number.isSafeInteger(countedRecords)) fail('sgos-record-index family count total exceeds safe integer range.');
  }
  for (const [family, count] of deltaCounts) {
    if ((record.familyCounts[family] ?? 0) < count) {
      fail(`sgos-record-index.familyCounts.${family} cannot be smaller than the current delta.`);
    }
  }
  integer(record.totalRecordCount, 'sgos-record-index.totalRecordCount');
  integer(record.totalBytes, 'sgos-record-index.totalBytes');
  if (record.totalRecordCount !== countedRecords) {
    fail('sgos-record-index.totalRecordCount must equal the cumulative familyCounts total.');
  }
  if (record.totalRecordCount > MAXIMUM_SGOS_PROCESS_RECORD_COUNT) {
    fail(`sgos-record-index.totalRecordCount exceeds the ${MAXIMUM_SGOS_PROCESS_RECORD_COUNT}-record Process bound.`);
  }
  if (record.totalBytes < deltaBytes) {
    fail('sgos-record-index.totalBytes cannot be smaller than the current delta byte total.');
  }
  if (record.totalBytes > MAXIMUM_SGOS_PROCESS_RECORD_BYTES) {
    fail(`sgos-record-index.totalBytes exceeds the ${MAXIMUM_SGOS_PROCESS_RECORD_BYTES}-byte Process bound.`);
  }
  if (record.sequence === 0 && (record.delta.length !== 0
      || record.totalRecordCount !== 0 || record.totalBytes !== 0
      || Object.keys(record.familyCounts).length !== 0)) {
    fail('sgos-record-index genesis must be an empty cumulative index.');
  }
}

export function createSgosRecordIndex(value) {
  return createContract('sgos-record-index', value, validateSgosRecordIndexRecord);
}

export function validateSgosRecordIndex(value) {
  return returnValidated(value, validateSgosRecordIndexRecord);
}

const CONTROL_EVENT_ACTIONS = Object.freeze([
  'process-transition', 'process-paused', 'process-resumed', 'execution-started',
  'execution-finished', 'human-requested', 'human-resolved', 'recovery-required',
  'recovery-resolved'
]);

function validateSgosMutableProcessState(value, label) {
  exactKeys(value, [
    'status', 'taskInstances', 'activeExecutions', 'openHumanRequests', 'activeLeases',
    'currentCheckpointSha256', 'processRevision', 'updatedAt'
  ], label);
  requireKeys(value, [
    'status', 'taskInstances', 'activeExecutions', 'openHumanRequests', 'activeLeases',
    'currentCheckpointSha256', 'processRevision', 'updatedAt'
  ], label);
  enumeration(value.status, PROCESS_STATES, `${label}.status`);
  object(value.taskInstances, `${label}.taskInstances`);
  for (const [id, instance] of Object.entries(value.taskInstances)) {
    validateTaskInstance(instance, `${label}.taskInstances.${id}`, id);
  }
  stringArray(value.activeExecutions, `${label}.activeExecutions`);
  stringArray(value.openHumanRequests, `${label}.openHumanRequests`, { digests: true });
  stringArray(value.activeLeases, `${label}.activeLeases`);
  if (value.currentCheckpointSha256 !== null) {
    digest(value.currentCheckpointSha256, `${label}.currentCheckpointSha256`);
  }
  integer(value.processRevision, `${label}.processRevision`, { minimum: 2 });
  timestamp(value.updatedAt, `${label}.updatedAt`);
}

function validateSgosControlEventRecord(record, requireHash) {
  validateBase(record, 'sgos-control-event', [
    'processId', 'processCoreSha256', 'priorControlEventSha256', 'beforeProcessSha256',
    'beforeProcessRevision', 'controlDepth', 'operatorTransitionCount', 'recordIndexSha256', 'action', 'result',
    'createdAt'
  ], [
    'processId', 'processCoreSha256', 'priorControlEventSha256', 'beforeProcessSha256',
    'beforeProcessRevision', 'controlDepth', 'operatorTransitionCount', 'recordIndexSha256', 'action', 'result',
    'createdAt'
  ], requireHash);
  identifier(record.processId, 'PROC', 'sgos-control-event.processId');
  digest(record.processCoreSha256, 'sgos-control-event.processCoreSha256');
  if (record.priorControlEventSha256 !== null) {
    digest(record.priorControlEventSha256, 'sgos-control-event.priorControlEventSha256');
  }
  digest(record.beforeProcessSha256, 'sgos-control-event.beforeProcessSha256');
  integer(record.beforeProcessRevision, 'sgos-control-event.beforeProcessRevision', { minimum: 1 });
  integer(record.controlDepth, 'sgos-control-event.controlDepth', { minimum: 1 });
  integer(record.operatorTransitionCount, 'sgos-control-event.operatorTransitionCount', {
    minimum: 0
  });
  if (record.operatorTransitionCount > record.controlDepth) {
    fail('sgos-control-event operatorTransitionCount cannot exceed controlDepth.');
  }
  digest(record.recordIndexSha256, 'sgos-control-event.recordIndexSha256');
  enumeration(record.action, CONTROL_EVENT_ACTIONS, 'sgos-control-event.action');
  validateSgosMutableProcessState(record.result, 'sgos-control-event.result');
  if (record.result.processRevision !== record.beforeProcessRevision + 1) {
    fail('sgos-control-event result revision must immediately follow beforeProcessRevision.');
  }
  timestamp(record.createdAt, 'sgos-control-event.createdAt');
  if (record.createdAt !== record.result.updatedAt) {
    fail('sgos-control-event.createdAt must equal the resulting Process updatedAt.');
  }
}

export function createSgosControlEvent(value) {
  return createContract('sgos-control-event', value, validateSgosControlEventRecord);
}

export function validateSgosControlEvent(value) {
  return returnValidated(value, validateSgosControlEventRecord);
}

function validateSgosControlSuccessorRecord(record, requireHash) {
  validateBase(record, 'sgos-control-successor', [
    'processId', 'beforeProcessSha256', 'controlEventSha256', 'controlDepth',
    'operatorTransitionCount', 'cumulativeInfrastructureBytes',
    'cumulativeInfrastructureRecords'
  ], [
    'processId', 'beforeProcessSha256', 'controlEventSha256', 'controlDepth',
    'operatorTransitionCount', 'cumulativeInfrastructureBytes',
    'cumulativeInfrastructureRecords'
  ], requireHash);
  identifier(record.processId, 'PROC', 'sgos-control-successor.processId');
  digest(record.beforeProcessSha256, 'sgos-control-successor.beforeProcessSha256');
  digest(record.controlEventSha256, 'sgos-control-successor.controlEventSha256');
  integer(record.controlDepth, 'sgos-control-successor.controlDepth', { minimum: 1 });
  integer(record.operatorTransitionCount, 'sgos-control-successor.operatorTransitionCount', {
    minimum: 0
  });
  if (record.operatorTransitionCount > record.controlDepth) {
    fail('sgos-control-successor operatorTransitionCount cannot exceed controlDepth.');
  }
  integer(record.cumulativeInfrastructureBytes,
    'sgos-control-successor.cumulativeInfrastructureBytes');
  integer(record.cumulativeInfrastructureRecords,
    'sgos-control-successor.cumulativeInfrastructureRecords');
}

export function createSgosControlSuccessor(value) {
  return createContract('sgos-control-successor', value, validateSgosControlSuccessorRecord);
}

export function validateSgosControlSuccessor(value) {
  return returnValidated(value, validateSgosControlSuccessorRecord);
}

function validateSgosTransitionIntentRecord(record, requireHash) {
  validateBase(record, 'sgos-transition-intent', [
    'processId', 'beforeProcessSha256', 'beforeProcessRevision',
    'priorRecordIndexSha256', 'reservations', 'nextRecordIndexSha256',
    'controlEvent', 'successorSha256', 'candidateProcessSha256'
  ], [
    'processId', 'beforeProcessSha256', 'beforeProcessRevision',
    'priorRecordIndexSha256', 'reservations', 'nextRecordIndexSha256',
    'controlEvent', 'successorSha256', 'candidateProcessSha256'
  ], requireHash);
  identifier(record.processId, 'PROC', 'sgos-transition-intent.processId');
  for (const field of [
    'beforeProcessSha256', 'priorRecordIndexSha256', 'nextRecordIndexSha256',
    'successorSha256', 'candidateProcessSha256'
  ]) digest(record[field], `sgos-transition-intent.${field}`);
  integer(record.beforeProcessRevision, 'sgos-transition-intent.beforeProcessRevision', {
    minimum: 1
  });
  if (!Array.isArray(record.reservations)
      || record.reservations.length > MAXIMUM_SGOS_RECORD_INDEX_DELTA) {
    fail(`sgos-transition-intent.reservations must contain at most ${MAXIMUM_SGOS_RECORD_INDEX_DELTA} exact entries.`);
  }
  let priorIdentity = null;
  const seen = new Set();
  for (const [position, reservation] of record.reservations.entries()) {
    const label = `sgos-transition-intent.reservations[${position}]`;
    exactKeys(reservation, ['family', 'recordSha256', 'bytes'], label);
    requireKeys(reservation, ['family', 'recordSha256', 'bytes'], label);
    enumeration(reservation.family, SGOS_RECORD_INDEX_FAMILIES, `${label}.family`);
    digest(reservation.recordSha256, `${label}.recordSha256`);
    integer(reservation.bytes, `${label}.bytes`, {
      minimum: 1
    });
    if (reservation.bytes > MAXIMUM_SGOS_RECORD_BYTES) {
      fail(`${label}.bytes exceeds the installed ${MAXIMUM_SGOS_RECORD_BYTES}-byte record bound.`);
    }
    const identity = `${reservation.family}\u0000${reservation.recordSha256}`;
    if (seen.has(identity) || (priorIdentity !== null
        && compareSgosCodePoints(priorIdentity, identity) >= 0)) {
      fail('sgos-transition-intent.reservations must be unique and canonically sorted.');
    }
    seen.add(identity);
    priorIdentity = identity;
  }
  if (!plainObject(record.controlEvent)) {
    fail('sgos-transition-intent.controlEvent must be an exact SGOS control event.');
  }
  validateSgosControlEventRecord(record.controlEvent, true);
  if (record.controlEvent.processId !== record.processId
      || record.controlEvent.beforeProcessSha256 !== record.beforeProcessSha256
      || record.controlEvent.beforeProcessRevision !== record.beforeProcessRevision
      || record.controlEvent.recordIndexSha256 !== record.nextRecordIndexSha256) {
    fail('sgos-transition-intent.controlEvent does not bind its predecessor and index.');
  }
}

export function createSgosTransitionIntent(value) {
  return createContract('sgos-transition-intent', value, validateSgosTransitionIntentRecord);
}

export function validateSgosTransitionIntent(value) {
  return returnValidated(value, validateSgosTransitionIntentRecord);
}

function validateGvmTaskAttemptRecord(record, requireHash) {
  validateBase(record, 'gvm-task-attempt', [
    'attemptId', 'processId', 'taskInstanceId', 'attemptNumber', 'parentAttemptId', 'reason',
    'taskContractSha256', 'executionHandleSha256', 'status', 'startedAt', 'completedAt'
  ], ['attemptId', 'processId', 'taskInstanceId', 'attemptNumber', 'parentAttemptId', 'reason', 'taskContractSha256', 'executionHandleSha256', 'status'], requireHash);
  identifier(record.attemptId, 'ATT', 'gvm-task-attempt.attemptId');
  identifier(record.processId, 'PROC', 'gvm-task-attempt.processId');
  string(record.taskInstanceId, 'gvm-task-attempt.taskInstanceId');
  integer(record.attemptNumber, 'gvm-task-attempt.attemptNumber', { minimum: 1 });
  if (record.parentAttemptId !== null) identifier(record.parentAttemptId, 'ATT', 'gvm-task-attempt.parentAttemptId');
  enumeration(record.reason, ['initial', 'retry', 'verification-failed', 'execution-failed', 'timeout', 'lease-lost', 'recovery', 'invalidated', 'manual'], 'gvm-task-attempt.reason');
  digest(record.taskContractSha256, 'gvm-task-attempt.taskContractSha256');
  digest(record.executionHandleSha256, 'gvm-task-attempt.executionHandleSha256');
  enumeration(record.status, TASK_STATES, 'gvm-task-attempt.status');
  if (record.startedAt != null) timestamp(record.startedAt, 'gvm-task-attempt.startedAt');
  if (record.completedAt != null) timestamp(record.completedAt, 'gvm-task-attempt.completedAt');
}

export function createGvmTaskAttempt(value) {
  return createContract('gvm-task-attempt', value, validateGvmTaskAttemptRecord, {
    identity: (record) => ({ processId: record.processId, taskInstanceId: record.taskInstanceId, attemptNumber: record.attemptNumber, parentAttemptId: record.parentAttemptId, taskContractSha256: record.taskContractSha256 })
  });
}

export function validateGvmTaskAttempt(value) {
  return returnValidated(value, validateGvmTaskAttemptRecord);
}

function verification(value, label) {
  exactKeys(value, ['status', 'checksSha256'], label);
  requireKeys(value, ['status'], label);
  enumeration(value.status, ['passed', 'failed', 'unavailable'], `${label}.status`);
  if (value.checksSha256 != null) digest(value.checksSha256, `${label}.checksSha256`);
}

function validateGvmTaskReceiptRecord(record, requireHash) {
  validateBase(record, 'gvm-task-receipt', [
    'processId', 'taskInstanceId', 'attemptId', 'attemptSha256', 'inputRefs', 'outputRefs', 'candidateSha256',
    'evidenceRefs', 'effectRefs', 'humanDecisionRefs', 'verification', 'completedAt'
  ], [
    'processId', 'taskInstanceId', 'attemptId', 'attemptSha256', 'inputRefs', 'outputRefs', 'candidateSha256',
    'evidenceRefs', 'effectRefs', 'humanDecisionRefs', 'verification', 'completedAt'
  ], requireHash);
  identifier(record.processId, 'PROC', 'gvm-task-receipt.processId');
  string(record.taskInstanceId, 'gvm-task-receipt.taskInstanceId');
  identifier(record.attemptId, 'ATT', 'gvm-task-receipt.attemptId');
  digest(record.attemptSha256, 'gvm-task-receipt.attemptSha256');
  for (const field of ['inputRefs', 'outputRefs', 'evidenceRefs', 'effectRefs', 'humanDecisionRefs']) stringArray(record[field], `gvm-task-receipt.${field}`);
  digest(record.candidateSha256, 'gvm-task-receipt.candidateSha256');
  verification(record.verification, 'gvm-task-receipt.verification');
  if (record.verification.status !== 'passed') fail('gvm-task-receipt requires passed verification.');
  timestamp(record.completedAt, 'gvm-task-receipt.completedAt');
}

export function createGvmTaskReceipt(value) {
  return createContract('gvm-task-receipt', value, validateGvmTaskReceiptRecord);
}

export function validateGvmTaskReceipt(value) {
  return returnValidated(value, validateGvmTaskReceiptRecord);
}

function validateGvmCheckpointRecord(record, requireHash) {
  validateBase(record, 'gvm-checkpoint', [
    'checkpointId', 'processId', 'processRevision', 'programSha256', 'policySnapshotSha256',
    'processBindingSha256', 'taskStates', 'readyTaskIds', 'activeExecutions',
    'openHumanRequests', 'activeLeases', 'priorCheckpointSha256', 'createdAt'
  ], [
    'checkpointId', 'processId', 'processRevision', 'programSha256', 'policySnapshotSha256',
    'processBindingSha256', 'taskStates', 'readyTaskIds', 'activeExecutions',
    'openHumanRequests', 'activeLeases', 'priorCheckpointSha256', 'createdAt'
  ], requireHash);
  identifier(record.checkpointId, 'CHK', 'gvm-checkpoint.checkpointId');
  identifier(record.processId, 'PROC', 'gvm-checkpoint.processId');
  integer(record.processRevision, 'gvm-checkpoint.processRevision');
  for (const field of ['programSha256', 'policySnapshotSha256', 'processBindingSha256']) digest(record[field], `gvm-checkpoint.${field}`);
  object(record.taskStates, 'gvm-checkpoint.taskStates');
  for (const [id, state] of Object.entries(record.taskStates)) {
    string(id, 'gvm-checkpoint.taskStates key');
    enumeration(state, TASK_STATES, `gvm-checkpoint.taskStates.${id}`);
  }
  stringArray(record.readyTaskIds, 'gvm-checkpoint.readyTaskIds');
  stringArray(record.activeExecutions, 'gvm-checkpoint.activeExecutions');
  stringArray(record.openHumanRequests, 'gvm-checkpoint.openHumanRequests', { digests: true });
  stringArray(record.activeLeases, 'gvm-checkpoint.activeLeases');
  if (record.priorCheckpointSha256 !== null) digest(record.priorCheckpointSha256, 'gvm-checkpoint.priorCheckpointSha256');
  timestamp(record.createdAt, 'gvm-checkpoint.createdAt');
}

export function createGvmCheckpoint(value) {
  return createContract('gvm-checkpoint', value, validateGvmCheckpointRecord, {
    identity: (record) => ({ processId: record.processId, processRevision: record.processRevision, priorCheckpointSha256: record.priorCheckpointSha256 })
  });
}

export function validateGvmCheckpoint(value) {
  return returnValidated(value, validateGvmCheckpointRecord);
}

function authorityRequirement(value, label) {
  exactKeys(value, ['kind', 'id', 'minimumAssurance', 'authoritySha256'], label);
  requireKeys(value, ['kind', 'id'], label);
  string(value.kind, `${label}.kind`);
  string(value.id, `${label}.id`);
  if (value.minimumAssurance != null) string(value.minimumAssurance, `${label}.minimumAssurance`);
  if (value.authoritySha256 != null) digest(value.authoritySha256, `${label}.authoritySha256`);
}

function configurationAuthority(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  exactKeys(value, ['kind', 'ref', 'commit', 'workflowBlobSha256'], label);
  requireKeys(value, ['kind', 'ref', 'commit', 'workflowBlobSha256'], label);
  enumeration(value.kind, ['approved-configuration-ref', 'verified-state-mirror'], `${label}.kind`);
  string(value.ref, `${label}.ref`, { pattern: /^refs\/(?:heads|remotes)\/[A-Za-z0-9._/-]+$/ });
  string(value.commit, `${label}.commit`, { pattern: /^[a-f0-9]{40,64}$/ });
  digest(value.workflowBlobSha256, `${label}.workflowBlobSha256`);
}

function validateHumanRequestRecord(record, requireHash) {
  validateBase(record, 'human-request', [
    'requestId', 'requestType', 'processId', 'taskInstanceId', 'checkpointSha256',
    'requestedBy', 'authorityRequired', 'configurationAuthority', 'prompt', 'options', 'inputSchema', 'sensitiveMode',
    'externalUrl', 'secretBroker', 'subjectSha256', 'policySnapshotSha256', 'status',
    'createdAt', 'expiresAt'
  ], [
    'requestId', 'requestType', 'processId', 'taskInstanceId', 'checkpointSha256',
    'requestedBy', 'authorityRequired', 'configurationAuthority', 'prompt', 'options', 'inputSchema', 'sensitiveMode',
    'externalUrl', 'secretBroker', 'subjectSha256', 'policySnapshotSha256', 'status',
    'createdAt', 'expiresAt'
  ], requireHash);
  identifier(record.requestId, 'HRQ', 'human-request.requestId');
  enumeration(record.requestType, HUMAN_REQUEST_TYPES, 'human-request.requestType');
  identifier(record.processId, 'PROC', 'human-request.processId');
  string(record.taskInstanceId, 'human-request.taskInstanceId');
  digest(record.checkpointSha256, 'human-request.checkpointSha256');
  principal(record.requestedBy, 'human-request.requestedBy');
  authorityRequirement(record.authorityRequired, 'human-request.authorityRequired');
  configurationAuthority(record.configurationAuthority, 'human-request.configurationAuthority');
  exactKeys(record.prompt, ['title', 'detail'], 'human-request.prompt');
  requireKeys(record.prompt, ['title', 'detail'], 'human-request.prompt');
  string(record.prompt.title, 'human-request.prompt.title');
  string(record.prompt.detail, 'human-request.prompt.detail');
  if (!Array.isArray(record.options)) fail('human-request.options must be an array.');
  record.options.forEach((option, index) => {
    const label = `human-request.options[${index}]`;
    exactKeys(option, ['id', 'label', 'consequence'], label);
    requireKeys(option, ['id', 'label'], label);
    string(option.id, `${label}.id`);
    string(option.label, `${label}.label`);
    if (option.consequence != null) string(option.consequence, `${label}.consequence`);
  });
  if (record.inputSchema !== null) object(record.inputSchema, 'human-request.inputSchema');
  enumeration(record.sensitiveMode, ['none', 'external-url', 'secret-broker'], 'human-request.sensitiveMode');
  if (record.externalUrl !== null) string(record.externalUrl, 'human-request.externalUrl', { pattern: /^https:\/\// });
  if (record.secretBroker !== null) string(record.secretBroker, 'human-request.secretBroker');
  if (record.sensitiveMode === 'none' && (record.externalUrl !== null || record.secretBroker !== null)) fail('human-request sensitiveMode=none cannot name a secret channel.');
  if (record.sensitiveMode === 'external-url' && (record.externalUrl === null || record.secretBroker !== null)) fail('human-request external-url mode requires only externalUrl.');
  if (record.sensitiveMode === 'secret-broker' && (record.secretBroker === null || record.externalUrl !== null)) fail('human-request secret-broker mode requires only secretBroker.');
  digest(record.subjectSha256, 'human-request.subjectSha256');
  digest(record.policySnapshotSha256, 'human-request.policySnapshotSha256');
  enumeration(record.status, ['open', 'answered', 'expired', 'cancelled'], 'human-request.status');
  timestamp(record.createdAt, 'human-request.createdAt');
  timestamp(record.expiresAt, 'human-request.expiresAt', { nullable: true });
}

export function createHumanRequest(value) {
  return createContract('human-request', value, validateHumanRequestRecord, {
    identity: (record) => ({ processId: record.processId, taskInstanceId: record.taskInstanceId, checkpointSha256: record.checkpointSha256, requestType: record.requestType, subjectSha256: record.subjectSha256 })
  });
}

export function validateHumanRequest(value) {
  return returnValidated(value, validateHumanRequestRecord);
}

function validateHumanResponseRecord(record, requireHash) {
  validateBase(record, 'human-response', [
    'responseId', 'requestSha256', 'processId', 'taskInstanceId', 'actor', 'decision',
    'input', 'respondedAt'
  ], ['responseId', 'requestSha256', 'processId', 'taskInstanceId', 'actor', 'decision', 'input', 'respondedAt'], requireHash);
  identifier(record.responseId, 'HRS', 'human-response.responseId');
  digest(record.requestSha256, 'human-response.requestSha256');
  identifier(record.processId, 'PROC', 'human-response.processId');
  string(record.taskInstanceId, 'human-response.taskInstanceId');
  principal(record.actor, 'human-response.actor');
  enumeration(record.decision, ['approved', 'rejected', 'selected', 'provided', 'cancelled'], 'human-response.decision');
  cloneJson(record.input, 'human-response.input');
  timestamp(record.respondedAt, 'human-response.respondedAt');
}

export function createHumanResponse(value) {
  return createContract('human-response', value, validateHumanResponseRecord, {
    identity: (record) => ({ requestSha256: record.requestSha256, actor: record.actor, decision: record.decision, input: record.input })
  });
}

export function validateHumanResponse(value) {
  return returnValidated(value, validateHumanResponseRecord);
}

function validateActionEvidenceRecord(record, requireHash) {
  validateBase(record, 'action-evidence', [
    'processId', 'taskInstanceId', 'attemptId', 'principalSha256', 'delegationSha256',
    'programSha256', 'taskContractSha256', 'executionUnitManifestSha256',
    'deviceManifestSha256', 'argumentsSha256', 'preStateSha256', 'rawResultSha256',
    'postStateSha256', 'verification', 'cost', 'latencyMs', 'gaps', 'evidenceRefs',
    'effectRefs', 'humanDecisionRefs', 'contradictions', 'createdAt'
  ], [
    'principalSha256', 'delegationSha256', 'programSha256', 'taskContractSha256',
    'executionUnitManifestSha256', 'deviceManifestSha256', 'argumentsSha256',
    'preStateSha256', 'rawResultSha256', 'postStateSha256', 'verification', 'cost',
    'latencyMs', 'gaps'
  ], requireHash);
  if (record.processId != null) identifier(record.processId, 'PROC', 'action-evidence.processId');
  if (record.taskInstanceId != null) string(record.taskInstanceId, 'action-evidence.taskInstanceId');
  if (record.attemptId != null) identifier(record.attemptId, 'ATT', 'action-evidence.attemptId');
  for (const field of [
    'principalSha256', 'delegationSha256', 'programSha256', 'taskContractSha256',
    'executionUnitManifestSha256', 'deviceManifestSha256', 'argumentsSha256',
    'preStateSha256', 'rawResultSha256', 'postStateSha256'
  ]) digest(record[field], `action-evidence.${field}`);
  verification(record.verification, 'action-evidence.verification');
  object(record.cost, 'action-evidence.cost');
  integer(record.latencyMs, 'action-evidence.latencyMs');
  stringArray(record.gaps, 'action-evidence.gaps');
  for (const field of ['evidenceRefs', 'effectRefs', 'humanDecisionRefs', 'contradictions']) {
    if (record[field] != null) stringArray(record[field], `action-evidence.${field}`);
  }
  if (record.createdAt != null) timestamp(record.createdAt, 'action-evidence.createdAt');
}

export function createActionEvidence(value) {
  return createContract('action-evidence', value, validateActionEvidenceRecord);
}

export function validateActionEvidence(value) {
  return returnValidated(value, validateActionEvidenceRecord);
}

function validateWorkObjectRecord(record, requireHash) {
  validateBase(record, 'work-object', ['objectId', 'processId', 'taskInstanceId', 'view', 'createdAt'], [
    'objectId', 'processId', 'taskInstanceId', 'view'
  ], requireHash);
  identifier(record.objectId, 'WKO', 'work-object.objectId');
  identifier(record.processId, 'PROC', 'work-object.processId');
  if (record.taskInstanceId !== null) string(record.taskInstanceId, 'work-object.taskInstanceId');
  exactKeys(record.view, ['type', 'schema', 'dataRef', 'actions'], 'work-object.view');
  requireKeys(record.view, ['type', 'schema', 'dataRef', 'actions'], 'work-object.view');
  enumeration(record.view.type, WORK_OBJECT_VIEW_TYPES, 'work-object.view.type');
  object(record.view.schema, 'work-object.view.schema');
  string(record.view.dataRef, 'work-object.view.dataRef', { pattern: /^sfref:/ });
  if (!Array.isArray(record.view.actions)) fail('work-object.view.actions must be an array.');
  record.view.actions.forEach((action, index) => {
    const label = `work-object.view.actions[${index}]`;
    exactKeys(action, ['id', 'label', 'operation', 'inputSchema'], label);
    requireKeys(action, ['id', 'label', 'operation', 'inputSchema'], label);
    string(action.id, `${label}.id`);
    string(action.label, `${label}.label`);
    enumeration(action.operation, WORK_OBJECT_OPERATIONS, `${label}.operation`);
    object(action.inputSchema, `${label}.inputSchema`);
  });
  if (record.createdAt != null) timestamp(record.createdAt, 'work-object.createdAt');
}

export function createWorkObject(value) {
  return createContract('work-object', value, validateWorkObjectRecord, {
    identity: (record) => ({ processId: record.processId, taskInstanceId: record.taskInstanceId, view: record.view })
  });
}

export function validateWorkObject(value) {
  return returnValidated(value, validateWorkObjectRecord);
}

const VALIDATORS = Object.freeze({
  'intent-envelope': validateIntentEnvelope,
  'intent-ir': validateIntentIr,
  'workflow-ir': validateWorkflowIr,
  'workflow-ratification': validateWorkflowRatification,
  'policy-snapshot': validatePolicySnapshot,
  'candidate-snapshot': validateCandidateSnapshot,
  'process-binding': validateProcessBinding,
  'gvm-program': validateGvmProgram,
  'gvm-process': validateGvmProcess,
  'sgos-record-index': validateSgosRecordIndex,
  'sgos-control-event': validateSgosControlEvent,
  'sgos-control-successor': validateSgosControlSuccessor,
  'sgos-transition-intent': validateSgosTransitionIntent,
  'gvm-task-attempt': validateGvmTaskAttempt,
  'gvm-task-receipt': validateGvmTaskReceipt,
  'gvm-checkpoint': validateGvmCheckpoint,
  'human-request': validateHumanRequest,
  'human-response': validateHumanResponse,
  'action-evidence': validateActionEvidence,
  'work-object': validateWorkObject
});

export function validateSgosRecord(value) {
  if (!plainObject(value) || typeof value.kind !== 'string') fail('SGOS record requires a kind.');
  const validator = VALIDATORS[value.kind];
  if (!validator) fail(`Unknown SGOS record kind '${value.kind}'.`);
  return validator(value);
}

export function sgosContractFamilies() {
  return Object.freeze(Object.keys(CONTRACTS));
}
