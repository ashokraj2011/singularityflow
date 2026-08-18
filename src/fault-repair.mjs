/**
 * Fault intake and the governed local guided-repair control plane.
 * `[FTR:REQ-010]` `[FTR:REQ-020]` `[FTR:REQ-060]` `[FTR:REQ-070]`
 *
 * Records live below the repository Git directory rather than in the application tree. Reporting
 * a failure must not make a clean checkout dirty, and an interrupted report must not become an
 * untracked governed artifact. Immutable envelopes, diagnoses, events, patches and receipts sit
 * beside mutable, integrity-checked indexes and state projections.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir, head, identity } from './git.mjs';
import { canonicalJson } from './specifications.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import {
  exists, nowIso, readJson, run, SingularityFlowError, snapshot, writeAtomic, writeJson
} from './util.mjs';

export const FAULT_ENVELOPE_SCHEMA_VERSION = 1;
export const FAULT_DIAGNOSIS_SCHEMA_VERSION = 1;
export const REPAIR_PLAN_SCHEMA_VERSION = 1;
export const REPAIR_STATE_SCHEMA_VERSION = 1;
export const REPAIR_RECEIPT_SCHEMA_VERSION = 1;

const ENVIRONMENTS = new Set(['local', 'ide', 'copilot', 'ci', 'integration', 'staging', 'production']);
const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
const FAULT_TYPES = new Set([
  'compile', 'lint', 'unit-test', 'integration-test', 'verification', 'runtime', 'dependency',
  'configuration', 'schema', 'deployment', 'production', 'security', 'policy', 'requirement',
  'architecture', 'unknown'
]);
const ACTION_CEILINGS = Object.freeze(['record', 'diagnose', 'propose', 'guided', 'bounded-auto']);
const ACTIVE_REPAIR_STATES = new Set([
  'recorded', 'diagnosis-ready', 'planned', 'proposed', 'awaiting-authorization', 'authorizing',
  'awaiting-patch', 'repairing', 'verifying', 'retry-ready', 'needs-human', 'challenge-required'
]);
// `challenge-opened` was emitted before the repair service created or linked a challenge. Keep
// those legacy records joinable so clicking Fix cannot mint duplicates, but never emit the status
// for a new repair. A future durable challenge link may terminalize the same repair explicitly.
const JOINABLE_REPAIR_STATES = new Set([...ACTIVE_REPAIR_STATES, 'challenge-opened']);
const TERMINAL_REPAIR_STATES = new Set([
  'resolved', 'exhausted', 'cancelled', 'quarantined', 'challenge-opened', 'follow-up-created'
]);
const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  maxAttempts: 3,
  maxMinutes: 20,
  maxTokens: 30_000,
  maximumInlineEvidenceBytes: 16 * 1024,
  maximumEvidenceBytes: 64 * 1024 * 1024,
  leaseMinutes: 60,
  boundedAuto: false,
  environmentCeilings: Object.freeze({
    local: 'guided', ide: 'guided', copilot: 'guided', ci: 'propose', integration: 'propose',
    staging: 'propose', production: 'diagnose'
  }),
  protectedPaths: Object.freeze(['.git', 'singularity', 'infra/production'])
});

function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function recordHash(value) {
  return sha256(canonicalJson(value));
}

function withIntegrity(core) {
  return { ...core, integrity: { algorithm: 'sha256', sha256: recordHash(core) } };
}

function withoutIntegrity(record) {
  const { integrity: _integrity, ...core } = record ?? {};
  return core;
}

function verifyIntegrity(record, label) {
  const expected = record?.integrity?.sha256;
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || recordHash(withoutIntegrity(record)) !== expected) {
    throw new SingularityFlowError(`${label} failed its integrity check.`, { code: 'FAULT_RECORD_INTEGRITY_INVALID' });
  }
  return record;
}

function requireSchema(record, expected, label) {
  const version = record?.schemaVersion;
  if (version !== expected) {
    throw new SingularityFlowError(
      `${label} schema ${String(version ?? 'missing')} is unsupported; this build supports ${expected} only.`,
      { code: 'FAULT_SCHEMA_UNSUPPORTED', details: { supported: { minimum: expected, maximum: expected }, received: version ?? null } }
    );
  }
  return verifyIntegrity(record, label);
}

function compact(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function requireText(value, label, { maximum = 4096, pattern = null } = {}) {
  const normalized = compact(value);
  if (!normalized) throw new SingularityFlowError(`${label} is required.`, { code: 'FAULT_FIELD_REQUIRED' });
  if (Buffer.byteLength(normalized) > maximum) {
    throw new SingularityFlowError(`${label} exceeds ${maximum} bytes.`, { code: 'FAULT_FIELD_TOO_LARGE' });
  }
  if (pattern && !pattern.test(normalized)) throw new SingularityFlowError(`${label} is invalid.`, { code: 'FAULT_FIELD_INVALID' });
  return normalized;
}

function optionalText(value, label, options = {}) {
  if (value == null || String(value).trim() === '') return null;
  return requireText(value, label, options);
}

function validDate(value, label, fallback = null) {
  const selected = value ?? fallback;
  if (selected == null) return null;
  const time = Date.parse(selected);
  if (!Number.isFinite(time)) throw new SingularityFlowError(`${label} must be an ISO timestamp.`, { code: 'FAULT_FIELD_INVALID' });
  return new Date(time).toISOString();
}

/**
 * Remove common credentials before any value reaches storage or model-visible diagnosis.
 * The audit fact records only the rule name and count; it never retains the removed bytes.
 */
const SENSITIVE_FIELD_NAMES = new Set([
  'password', 'passwd', 'pwd', 'token', 'authtoken', 'accesstoken', 'refreshtoken', 'idtoken',
  'sastoken', 'clientsecret', 'clientassertion', 'secret', 'secretkey', 'secretaccesskey',
  'apikey', 'accesskey', 'accountkey', 'privatekey', 'connectionstring', 'databaseurl', 'dburl',
  'mongodburi', 'redisurl', 'sharedaccesskey', 'sharedaccesssignature'
]);
const SENSITIVE_FIELD_SOURCE = [
  'password', 'passwd', 'pwd', 'token', 'auth[_-]?token', 'access[_-]?token', 'refresh[_-]?token',
  'id[_-]?token', 'sas[_-]?token', 'client[_-]?secret', 'client[_-]?assertion', 'secret',
  'secret[_-]?key', 'secret[_-]?access[_-]?key', 'api[_-]?key', 'access[_-]?key',
  'account[_-]?key', 'private[_-]?key', 'connection[_-]?string', 'database[_-]?url', 'db[_-]?url',
  'mongodb[_-]?uri', 'redis[_-]?url', 'shared[_-]?access[_-]?key',
  'shared[_-]?access[_-]?signature'
].join('|');
const SECRET_RULES = Object.freeze([
  ['private-key', /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
    () => '[REDACTED_PRIVATE_KEY]'],
  ['authorization', /\b(authorization\s*:\s*(?:bearer|basic)\s+)(?!\[REDACTED)[^\s,;]+/gi,
    (_match, prefix) => `${prefix}[REDACTED]`],
  ['quoted-assignment', new RegExp(`(["'])(${SENSITIVE_FIELD_SOURCE})\\1\\s*:\\s*(["'])(?!\\[REDACTED)([\\s\\S]*?)\\3`, 'gi'),
    (_match, keyQuote, key, valueQuote) => `${keyQuote}${key}${keyQuote}:${valueQuote}[REDACTED]${valueQuote}`],
  ['assignment', new RegExp(`\\b(${SENSITIVE_FIELD_SOURCE})\\s*[:=]\\s*(?!\\[REDACTED)[^\\s,;]+`, 'gi'),
    (_match, key) => `${key}=[REDACTED]`],
  ['query-credential', new RegExp(`([?&](?:${SENSITIVE_FIELD_SOURCE})=)(?!%5BREDACTED|\\[REDACTED)[^&#\\s]+`, 'gi'),
    (_match, prefix) => `${prefix}[REDACTED]`],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    () => '[REDACTED_GITHUB_TOKEN]'],
  ['openai-token', /\bsk-[A-Za-z0-9_-]{16,}\b/g, () => '[REDACTED_API_TOKEN]'],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, () => '[REDACTED_AWS_KEY]'],
  ['jwt', /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, () => '[REDACTED_JWT]'],
  ['url-credentials', /((?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql):\/\/)[^\s/@:]*:[^\s/@]+@/gi,
    (_match, scheme) => `${scheme}[REDACTED]@`],
  ['jdbc-credentials', /(jdbc:[a-z0-9]+:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    (_match, scheme) => `${scheme}[REDACTED]@`]
]);

function sensitiveFieldName(value) {
  return SENSITIVE_FIELD_NAMES.has(String(value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase());
}

function sanitizedMarker(value) {
  return typeof value === 'string' && /^\[REDACTED(?:_|\])/.test(value);
}

function sanitizeTextPatterns(value) {
  let text = String(value ?? '');
  const redactions = [];
  for (const [rule, expression, replacement] of SECRET_RULES) {
    let count = 0;
    text = text.replace(expression, (...args) => {
      count += 1;
      return replacement(...args);
    });
    if (count) redactions.push({ rule, count });
  }
  return { text, redactions };
}

function sanitizeStructuredValue(value, redactions, pathLabel, key = null) {
  if (key != null && sensitiveFieldName(key) && value != null && !sanitizedMarker(value)) {
    redactions.push({ rule: 'sensitive-field', count: 1, field: pathLabel });
    return { value: '[REDACTED]', changed: true };
  }
  if (typeof value === 'string') {
    const result = sanitizeTextPatterns(value);
    redactions.push(...result.redactions.map((entry) => ({ ...entry, field: pathLabel })));
    return { value: result.text, changed: result.text !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map((entry, index) => {
      const sanitized = sanitizeStructuredValue(entry, redactions, `${pathLabel}[${index}]`);
      changed ||= sanitized.changed;
      return sanitized.value;
    });
    return { value: entries, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const entries = Object.entries(value).map(([entryKey, entry]) => {
      const sanitized = sanitizeStructuredValue(entry, redactions, `${pathLabel}.${entryKey}`, entryKey);
      changed ||= sanitized.changed;
      return [entryKey, sanitized.value];
    });
    return { value: Object.fromEntries(entries), changed };
  }
  return { value, changed: false };
}

export function sanitizeFaultText(value) {
  let text = String(value ?? '');
  const redactions = [];
  const source = text.trim();
  if ((source.startsWith('{') && source.endsWith('}')) || (source.startsWith('[') && source.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text);
      const structured = sanitizeStructuredValue(parsed, redactions, 'json');
      if (structured.changed) text = JSON.stringify(structured.value, null, text.includes('\n') ? 2 : 0);
    } catch {
      // Logs frequently contain JSON fragments around ordinary text. The textual rules below still
      // redact quoted credential keys; malformed JSON is evidence, not a parsing error.
    }
  }
  // Parse complete JSON before applying textual patterns so escaped quotes cannot make a regex
  // truncate a credential value and leave its suffix behind. Text logs and malformed JSON still
  // receive the same deterministic pattern pass.
  const patterned = sanitizeTextPatterns(text);
  text = patterned.text;
  redactions.push(...patterned.redactions);
  const residual = sanitizeTextPatterns(text);
  if (residual.redactions.length) {
    throw new SingularityFlowError('Fault evidence could not be safely redacted.', {
      code: 'FAULT_REDACTION_INCOMPLETE'
    });
  }
  return { text, redactions };
}

function sanitizeValue(value, redactions, pathLabel = 'value') {
  return sanitizeStructuredValue(value, redactions, pathLabel).value;
}

export function normalizeFaultRepairPolicy(value = {}) {
  if (value == null) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('faultRepair must be an object.');
  const allowed = new Set([
    'enabled', 'maxAttempts', 'maxMinutes', 'maxTokens', 'maximumInlineEvidenceBytes',
    'maximumEvidenceBytes', 'leaseMinutes', 'boundedAuto', 'environmentCeilings', 'protectedPaths'
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`faultRepair contains unknown field '${key}'.`);
  if (value.protectedPaths != null && !Array.isArray(value.protectedPaths)) {
    throw new SingularityFlowError('faultRepair.protectedPaths must be an array.');
  }
  if (value.environmentCeilings != null
    && (!value.environmentCeilings || typeof value.environmentCeilings !== 'object' || Array.isArray(value.environmentCeilings))) {
    throw new SingularityFlowError('faultRepair.environmentCeilings must be an object.');
  }
  const policy = {
    ...DEFAULT_POLICY,
    ...value,
    environmentCeilings: { ...DEFAULT_POLICY.environmentCeilings, ...(value.environmentCeilings ?? {}) },
    protectedPaths: [...new Set(value.protectedPaths ?? DEFAULT_POLICY.protectedPaths)]
  };
  if (typeof policy.enabled !== 'boolean' || typeof policy.boundedAuto !== 'boolean') {
    throw new SingularityFlowError('faultRepair.enabled and faultRepair.boundedAuto must be boolean.');
  }
  for (const [field, minimum, maximum] of [
    ['maxAttempts', 1, 20], ['maxMinutes', 1, 1440], ['maxTokens', 1, 10_000_000],
    ['maximumInlineEvidenceBytes', 1, 65_536], ['maximumEvidenceBytes', 1024, 1024 * 1024 * 1024],
    ['leaseMinutes', 1, 1440]
  ]) {
    if (!Number.isInteger(policy[field]) || policy[field] < minimum || policy[field] > maximum) {
      throw new SingularityFlowError(`faultRepair.${field} must be an integer from ${minimum} through ${maximum}.`);
    }
  }
  for (const [environment, ceiling] of Object.entries(policy.environmentCeilings)) {
    if (!ENVIRONMENTS.has(environment) || !ACTION_CEILINGS.includes(ceiling)) {
      throw new SingularityFlowError(`faultRepair.environmentCeilings.${environment} is invalid.`);
    }
  }
  for (const prefix of policy.protectedPaths) normalizePathPrefix(prefix, 'faultRepair.protectedPaths');
  return Object.freeze({ ...policy, protectedPaths: Object.freeze([...policy.protectedPaths]) });
}

/** Apply caller limits without allowing them to replace or broaden governed policy. */
export function restrictFaultRepairPolicy(governed = {}, restriction = {}) {
  const base = normalizeFaultRepairPolicy(governed);
  if (restriction == null) return base;
  if (!restriction || typeof restriction !== 'object' || Array.isArray(restriction)) {
    throw new SingularityFlowError('faultRepair policy restriction must be an object.');
  }
  // Normalize once for type/range/unknown-field validation, but consult the raw keys below so an
  // empty restriction really means "no additional limit" rather than silently reapplying defaults.
  const requested = normalizeFaultRepairPolicy(restriction);
  const ceilings = {};
  for (const environment of ENVIRONMENTS) {
    const baseIndex = ACTION_CEILINGS.indexOf(base.environmentCeilings[environment]);
    const requestedIndex = Object.hasOwn(restriction.environmentCeilings ?? {}, environment)
      ? ACTION_CEILINGS.indexOf(requested.environmentCeilings[environment])
      : baseIndex;
    ceilings[environment] = ACTION_CEILINGS[Math.min(baseIndex, requestedIndex)];
  }
  const minWhenSupplied = (field) => Object.hasOwn(restriction, field)
    ? Math.min(base[field], requested[field])
    : base[field];
  return normalizeFaultRepairPolicy({
    enabled: Object.hasOwn(restriction, 'enabled') ? base.enabled && requested.enabled : base.enabled,
    boundedAuto: Object.hasOwn(restriction, 'boundedAuto') ? base.boundedAuto && requested.boundedAuto : base.boundedAuto,
    maxAttempts: minWhenSupplied('maxAttempts'),
    maxMinutes: minWhenSupplied('maxMinutes'),
    maxTokens: minWhenSupplied('maxTokens'),
    maximumInlineEvidenceBytes: minWhenSupplied('maximumInlineEvidenceBytes'),
    maximumEvidenceBytes: minWhenSupplied('maximumEvidenceBytes'),
    leaseMinutes: minWhenSupplied('leaseMinutes'),
    environmentCeilings: ceilings,
    protectedPaths: Object.hasOwn(restriction, 'protectedPaths')
      ? [...new Set([...base.protectedPaths, ...requested.protectedPaths])]
      : [...base.protectedPaths]
  });
}

const FAIL_CLOSED_POLICY = Object.freeze({
  boundedAuto: false,
  environmentCeilings: Object.freeze({
    local: 'diagnose', ide: 'diagnose', copilot: 'diagnose', ci: 'record', integration: 'record',
    staging: 'record', production: 'record'
  })
});

/** Resolve current or Story-pinned policy, then apply caller limits only as restrictions. */
export async function governedFaultRepairPolicy(root, {
  story = null, restriction = {}, failClosed = false
} = {}) {
  const configuration = path.join(root, 'singularity', 'workflow.yml');
  if (!await exists(configuration)) {
    return restrictFaultRepairPolicy(failClosed ? FAIL_CLOSED_POLICY : {}, restriction);
  }
  const { loadDefinition } = await import('./config.mjs');
  const definition = await loadDefinition(root);
  let governed = definition.faultRepair ?? {};
  if (story) {
    const { loadStoryAggregate } = await import('./state-stores.mjs');
    let workflow;
    try {
      workflow = await loadStoryAggregate(root, definition, story);
    } catch (error) {
      throw new SingularityFlowError(
        `Pinned fault-repair policy for Story '${story}' is unavailable: ${error.message}`,
        { code: 'FAULT_POLICY_UNAVAILABLE' }
      );
    }
    if (!workflow.resolution?.faultRepair) {
      throw new SingularityFlowError(
        `Story '${story}' has no pinned fault-repair policy.`,
        { code: 'FAULT_POLICY_UNAVAILABLE' }
      );
    }
    governed = workflow.resolution.faultRepair;
  }
  return restrictFaultRepairPolicy(governed, restriction);
}

function stateRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'fault-repair');
}

export function faultRepairStateRoot(root) {
  return stateRoot(root);
}

function statePath(root, ...segments) {
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
      throw new SingularityFlowError('Fault state path contains an unsafe segment.', { code: 'FAULT_STATE_PATH_UNSAFE' });
    }
  }
  return path.join(stateRoot(root), ...segments);
}

async function safeDirectory(directory, boundary) {
  const relative = path.relative(boundary, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SingularityFlowError('Fault state escaped its Git-local boundary.', { code: 'FAULT_STATE_PATH_UNSAFE' });
  }
  await mkdir(boundary, { recursive: true, mode: 0o700 });
  const boundaryInfo = await lstat(boundary);
  if (boundaryInfo.isSymbolicLink() || !boundaryInfo.isDirectory()) {
    throw new SingularityFlowError(`Fault state boundary is unsafe: ${boundary}`, { code: 'FAULT_STATE_PATH_UNSAFE' });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let current = boundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SingularityFlowError(`Fault state directory is unsafe: ${current}`, { code: 'FAULT_STATE_PATH_UNSAFE' });
    }
  }
}

async function safeWrite(root, file, value) {
  const boundary = stateRoot(root);
  await safeDirectory(path.dirname(file), boundary);
  const current = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (current?.isSymbolicLink() || current?.isDirectory()) {
    throw new SingularityFlowError(`Fault state target is unsafe: ${file}`, { code: 'FAULT_STATE_PATH_UNSAFE' });
  }
  await writeJson(file, value);
}

async function immutableWrite(root, file, value, label) {
  if (await exists(file)) {
    const prior = await readJson(file);
    if (canonicalJson(prior) !== canonicalJson(value)) {
      throw new SingularityFlowError(`${label} already exists with different bytes.`, { code: 'FAULT_IMMUTABILITY_VIOLATION' });
    }
    return false;
  }
  await safeWrite(root, file, value);
  return true;
}

async function directoryRecords(directory, reader) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const records = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    records.push(await reader(path.join(directory, entry.name)));
  }
  return records;
}

function nextId(prefix) {
  const time = Date.now().toString(36).toUpperCase();
  const entropy = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  return `${prefix}-${time}-${entropy}`;
}

function requireId(value, prefix, label) {
  return requireText(value, label, { maximum: 96, pattern: new RegExp(`^${prefix}-[A-Z0-9][A-Z0-9-]*$`, 'i') }).toUpperCase();
}

function normalizePathPrefix(value, label = 'path') {
  const input = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!input || input === '.' || path.posix.isAbsolute(input) || input.split('/').includes('..') || input.includes('\0')) {
    throw new SingularityFlowError(`${label} must be a bounded repository-relative path, not the repository root, and may not contain '..'.`, { code: 'REPAIR_SCOPE_INVALID' });
  }
  return input;
}

function pathInside(candidate, prefix) {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function normalizedActor(root, supplied = null) {
  const observed = supplied ?? identity(root, { offline: true });
  const subject = optionalText(observed.email ?? observed.login ?? observed.subject ?? observed.name, 'identity.subject', { maximum: 320 }) ?? 'unknown-user';
  const authorityCore = {
    subject,
    email: optionalText(observed.email, 'identity.email', { maximum: 320 }),
    login: optionalText(observed.login, 'identity.login', { maximum: 160 })
  };
  return { ...authorityCore, authoritySnapshot: `sha256:${recordHash(authorityCore)}` };
}

function normalizeFailure(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('failure must be an object.');
  const type = value.type ?? 'unknown';
  if (!FAULT_TYPES.has(type)) throw new SingularityFlowError(`Unknown fault type '${type}'.`, { code: 'FAULT_TYPE_INVALID' });
  const exitCode = value.exitCode == null ? null : Number(value.exitCode);
  if (exitCode != null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 0xffff_ffff)) {
    throw new SingularityFlowError('failure.exitCode must be an unsigned 32-bit integer.', { code: 'FAULT_FIELD_INVALID' });
  }
  if (value.commandArgv != null && !Array.isArray(value.commandArgv)) {
    throw new SingularityFlowError('failure.commandArgv must be an array.', { code: 'FAULT_FIELD_INVALID' });
  }
  const commandArgv = value.commandArgv == null ? null : value.commandArgv.map((entry) => requireText(entry, 'failure.commandArgv[]', { maximum: 4096 }));
  if (commandArgv && !commandArgv.length) throw new SingularityFlowError('failure.commandArgv must not be empty.');
  return {
    type,
    command: optionalText(value.command ?? (commandArgv ? commandArgv.join(' ') : null), 'failure.command', { maximum: 16_384 }),
    commandArgv,
    exitCode,
    message: optionalText(value.message, 'failure.message', { maximum: 32_768 })
  };
}

function normalizeEvidenceReference(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new SingularityFlowError(`evidence[${index}] must be an object.`);
  const type = requireText(entry.type ?? 'artifact', `evidence[${index}].type`, { maximum: 64, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ });
  const mediaType = optionalText(entry.mediaType, `evidence[${index}].mediaType`, { maximum: 160 }) ?? 'application/octet-stream';
  if (entry.localPath != null || entry.inline != null) return { type, mediaType, localPath: entry.localPath ?? null, inline: entry.inline ?? null };
  const uri = requireText(entry.uri, `evidence[${index}].uri`, { maximum: 4096 });
  const hash = requireText(entry.hash, `evidence[${index}].hash`, { maximum: 80, pattern: /^sha256:[a-f0-9]{64}$/ });
  const bytes = entry.bytes == null ? null : Number(entry.bytes);
  if (bytes != null && (!Number.isInteger(bytes) || bytes < 0)) throw new SingularityFlowError(`evidence[${index}].bytes is invalid.`);
  return { type, uri, hash, bytes, mediaType };
}

async function materializeEvidence(root, entries, policy, redactions) {
  const evidence = [];
  for (let index = 0; index < entries.length; index += 1) {
    const normalized = normalizeEvidenceReference(entries[index], index);
    if (normalized.uri) { evidence.push(normalized); continue; }
    let bytes;
    let name;
    if (normalized.localPath != null) {
      const absolute = path.resolve(root, String(normalized.localPath));
      const relative = path.relative(root, absolute);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new SingularityFlowError('Local fault evidence must be a repository-relative regular file; use an immutable URI and hash for external evidence.', { code: 'FAULT_EVIDENCE_PATH_UNSAFE' });
      }
      const linkInfo = await lstat(absolute);
      if (linkInfo.isSymbolicLink()) {
        throw new SingularityFlowError('Local fault evidence may not be a symbolic link.', { code: 'FAULT_EVIDENCE_PATH_UNSAFE' });
      }
      const resolved = await realpath(absolute);
      const resolvedRelative = path.relative(await realpath(root), resolved);
      if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
        throw new SingularityFlowError('Local fault evidence escaped the repository.', { code: 'FAULT_EVIDENCE_PATH_UNSAFE' });
      }
      const info = await stat(resolved);
      if (!info.isFile()) throw new SingularityFlowError(`Evidence is not a regular file: ${absolute}`, { code: 'FAULT_EVIDENCE_INVALID' });
      if (info.size > policy.maximumEvidenceBytes) throw new SingularityFlowError(`Evidence exceeds ${policy.maximumEvidenceBytes} bytes.`, { code: 'FAULT_EVIDENCE_TOO_LARGE' });
      bytes = await readFile(resolved);
      name = path.basename(absolute);
    } else {
      bytes = Buffer.from(String(normalized.inline ?? ''), 'utf8');
      name = `inline-${index}.txt`;
      if (bytes.length > policy.maximumInlineEvidenceBytes) throw new SingularityFlowError(`Inline evidence exceeds ${policy.maximumInlineEvidenceBytes} bytes.`, { code: 'FAULT_EVIDENCE_TOO_LARGE' });
    }
    if (bytes.includes(0)) throw new SingularityFlowError(`Evidence '${name}' is binary; supply an immutable URI and hash instead.`, { code: 'FAULT_EVIDENCE_REFERENCE_REQUIRED' });
    const sanitized = sanitizeFaultText(bytes.toString('utf8'));
    redactions.push(...sanitized.redactions.map((entry) => ({ ...entry, field: `evidence[${index}]` })));
    const stored = Buffer.from(sanitized.text, 'utf8');
    const digest = sha256(stored);
    const target = statePath(root, 'evidence', `${digest}.txt`);
    if (!await exists(target)) {
      await safeDirectory(path.dirname(target), stateRoot(root));
      await writeAtomic(target, stored, { mode: 0o600 });
    }
    evidence.push({
      type: normalized.type,
      uri: `artifact://fault-evidence/${digest}/${encodeURIComponent(name)}`,
      hash: `sha256:${digest}`,
      bytes: stored.length,
      mediaType: normalized.mediaType === 'application/octet-stream' ? 'text/plain' : normalized.mediaType
    });
  }
  return evidence;
}

function normalizedSignature(envelope) {
  const signatureCore = {
    type: envelope.failure.type,
    command: compact(envelope.failure.command ?? '').toLowerCase(),
    commandArgv: (envelope.failure.commandArgv ?? []).map((entry) => compact(entry)),
    message: compact(envelope.failure.message ?? '').toLowerCase(),
    environment: envelope.environment,
    baseline: envelope.build?.commit ?? null,
    capability: envelope.capability ?? null
  };
  return `sha256:${recordHash(signatureCore)}`;
}

export function faultSignature(envelope) {
  return normalizedSignature(envelope);
}

function envelopeRequestCore(input, evidence) {
  return {
    source: input.source,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt,
    environment: input.environment,
    severity: input.severity,
    story: input.story,
    capability: input.capability,
    build: input.build,
    failure: input.failure,
    evidence,
    requestedAction: input.requestedAction,
    parentRepairId: input.parentRepairId
  };
}

async function normalizeEnvelopeInput(root, raw = {}, { policy, actor } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SingularityFlowError('Fault envelope must be an object.');
  if (raw.schemaVersion != null && raw.schemaVersion !== 1) {
    throw new SingularityFlowError(`FaultEnvelope schema ${raw.schemaVersion} is unsupported; this build supports 1 only.`, { code: 'FAULT_SCHEMA_UNSUPPORTED' });
  }
  const redactions = [];
  const sanitized = sanitizeValue(raw, redactions, 'fault');
  const source = requireText(sanitized.source, 'source', { maximum: 128, pattern: /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i });
  const environment = sanitized.environment ?? 'local';
  if (!ENVIRONMENTS.has(environment)) throw new SingularityFlowError(`Unknown fault environment '${environment}'.`, { code: 'FAULT_ENVIRONMENT_INVALID' });
  const severity = sanitized.severity ?? 'medium';
  if (!SEVERITIES.has(severity)) throw new SingularityFlowError(`Unknown fault severity '${severity}'.`, { code: 'FAULT_SEVERITY_INVALID' });
  const failure = normalizeFailure(sanitized.failure ?? {});
  if (sanitized.evidence != null && !Array.isArray(sanitized.evidence)) {
    throw new SingularityFlowError('evidence must be an array.', { code: 'FAULT_FIELD_INVALID' });
  }
  const currentHead = head(root);
  if (sanitized.build != null
    && (!sanitized.build || typeof sanitized.build !== 'object' || Array.isArray(sanitized.build))) {
    throw new SingularityFlowError('build must be an object.', { code: 'FAULT_FIELD_INVALID' });
  }
  const suppliedCommit = optionalText(sanitized.build?.commit, 'build.commit', { maximum: 64, pattern: /^[a-f0-9]{7,64}$/i });
  const resolvedCommit = suppliedCommit
    ? run('git', ['rev-parse', '--verify', `${suppliedCommit}^{commit}`], { cwd: root, allowFailure: true }).stdout.trim() || suppliedCommit
    : currentHead;
  const build = sanitized.build == null ? { id: null, commit: currentHead } : {
    id: optionalText(sanitized.build.id, 'build.id', { maximum: 256 }),
    commit: resolvedCommit
  };
  const requestedAction = sanitized.requestedAction ?? 'policy-decides';
  if (!['policy-decides', ...ACTION_CEILINGS].includes(requestedAction)) throw new SingularityFlowError(`Unknown requested action '${requestedAction}'.`);
  const occurredAt = validDate(sanitized.occurredAt, 'occurredAt', nowIso());
  const correlationId = optionalText(sanitized.correlationId, 'correlationId', { maximum: 512 });
  const story = optionalText(sanitized.story, 'story', { maximum: 96 });
  const capability = optionalText(sanitized.capability, 'capability', { maximum: 128 });
  const parentRepairId = sanitized.parentRepairId ? requireId(sanitized.parentRepairId, 'RPR', 'parentRepairId') : null;
  const faultId = sanitized.faultId ? requireId(sanitized.faultId, 'FLT', 'faultId') : null;
  const idempotencyKey = optionalText(sanitized.idempotencyKey, 'idempotencyKey', { maximum: 512 });
  const resolvedActor = normalizedActor(root, actor);
  // Evidence is the first step that writes content-addressed bytes. Validate every other envelope
  // field before reaching it so a malformed request is observationally inert.
  const evidence = await materializeEvidence(root, sanitized.evidence ?? [], policy, redactions);
  const input = {
    source,
    correlationId,
    occurredAt,
    environment,
    severity,
    story,
    capability,
    build,
    failure,
    evidence,
    requestedAction,
    parentRepairId
  };
  return {
    input,
    actor: resolvedActor,
    faultId,
    idempotencyKey,
    redactions,
    // A generated receipt timestamp is not part of caller intent. Omitting occurredAt must remain
    // idempotent across retries even though the stored envelope records when each observation arose.
    requestSha256: recordHash(envelopeRequestCore({
      ...input,
      occurredAt: sanitized.occurredAt == null ? null : input.occurredAt
    }, evidence))
  };
}

async function readFaultFile(file) {
  return requireSchema(await readJson(file), FAULT_ENVELOPE_SCHEMA_VERSION, 'FaultEnvelope');
}

function requireOccurrenceGroup(record, { signature, groupId, baseline }) {
  const group = requireSchema(record, 1, 'FaultOccurrenceGroup');
  const occurrences = group.occurrences;
  const structurallyValid = group.recordType === 'fault-occurrence-group'
    && group.signature === signature
    && group.groupId === groupId
    && group.baseline === baseline
    && Array.isArray(occurrences)
    && occurrences.every((entry) => typeof entry === 'string' && /^FLT-[A-Z0-9][A-Z0-9-]*$/i.test(entry))
    && new Set(occurrences).size === occurrences.length
    && group.count === occurrences.length
    && Number.isFinite(Date.parse(group.firstSeenAt))
    && Number.isFinite(Date.parse(group.lastSeenAt));
  if (!structurallyValid) {
    throw new SingularityFlowError('FaultOccurrenceGroup does not match the fault being recorded.', {
      code: 'FAULT_RECORD_INTEGRITY_INVALID'
    });
  }
  return group;
}

export async function readFault(root, faultId) {
  const id = requireId(faultId, 'FLT', 'faultId');
  return readFaultFile(statePath(root, 'faults', `${id}.json`));
}

export async function reportFault(root, raw, { policy: configuredPolicy = {}, actor = null } = {}) {
  const policy = normalizeFaultRepairPolicy(configuredPolicy);
  if (!policy.enabled) throw new SingularityFlowError('Fault intake is disabled by repository policy.', { code: 'FAULT_INTAKE_DISABLED' });
  const normalized = await normalizeEnvelopeInput(root, raw, { policy, actor });
  return withSubjectLock(root, { kind: 'fault-intake', id: 'repository' }, async () => {
    const idempotencyHash = normalized.idempotencyKey ? sha256(normalized.idempotencyKey) : null;
    if (idempotencyHash) {
      const pointerPath = statePath(root, 'idempotency', `${idempotencyHash}.json`);
      if (await exists(pointerPath)) {
        const pointer = await readJson(pointerPath);
        if (pointer.requestSha256 !== normalized.requestSha256) {
          throw new SingularityFlowError('The idempotency key was already used for a different fault.', { code: 'FAULT_IDEMPOTENCY_CONFLICT' });
        }
        return { fault: await readFault(root, pointer.faultId), created: false, idempotent: true };
      }
    }
    const faultId = normalized.faultId ?? nextId('FLT');
    const receivedAt = nowIso();
    const core = {
      schemaVersion: FAULT_ENVELOPE_SCHEMA_VERSION,
      recordType: 'fault-envelope',
      faultId,
      source: normalized.input.source,
      correlationId: normalized.input.correlationId,
      occurredAt: normalized.input.occurredAt,
      receivedAt,
      environment: normalized.input.environment,
      severity: normalized.input.severity,
      identity: normalized.actor,
      story: normalized.input.story,
      capability: normalized.input.capability,
      build: normalized.input.build,
      failure: normalized.input.failure,
      evidence: normalized.input.evidence,
      requestedAction: normalized.input.requestedAction,
      parentRepairId: normalized.input.parentRepairId,
      redaction: {
        applied: normalized.redactions.length > 0,
        occurrences: normalized.redactions.reduce((sum, entry) => sum + entry.count, 0),
        facts: normalized.redactions.map(({ rule, count, field }) => ({ rule, count, field }))
      }
    };
    const signature = normalizedSignature(core);
    const groupId = `FOG-${signature.slice(-16).toUpperCase()}`;
    const groupPath = statePath(root, 'groups', `${signature.slice(7)}.json`);
    const existing = await exists(groupPath)
      ? requireOccurrenceGroup(await readJson(groupPath), {
          signature, groupId, baseline: core.build.commit
        })
      : null;
    // Validate the mutable group before writing the immutable fault or rewriting the group.
    const fault = withIntegrity({ ...core, signature, occurrenceGroup: groupId });
    await immutableWrite(root, statePath(root, 'faults', `${faultId}.json`), fault, `Fault '${faultId}'`);

    const occurrences = [...new Set([...(existing?.occurrences ?? []), faultId])];
    const groupCore = {
      schemaVersion: 1, recordType: 'fault-occurrence-group', groupId, signature,
      baseline: fault.build.commit, firstSeenAt: existing?.firstSeenAt ?? receivedAt,
      lastSeenAt: receivedAt, count: occurrences.length, occurrences
    };
    await safeWrite(root, groupPath, withIntegrity(groupCore));
    if (idempotencyHash) {
      await safeWrite(root, statePath(root, 'idempotency', `${idempotencyHash}.json`), {
        schemaVersion: 1, idempotencyHash: `sha256:${idempotencyHash}`, requestSha256: normalized.requestSha256,
        faultId, recordedAt: receivedAt
      });
    }
    return { fault, created: true, idempotent: false };
  });
}

async function repairStates(root) {
  const directory = statePath(root, 'repairs');
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const states = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^RPR-/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name, 'state.json');
    if (!await exists(file)) continue;
    states.push(requireSchema(await readJson(file), REPAIR_STATE_SCHEMA_VERSION, 'RepairState'));
  }
  return states;
}

export async function listFaults(root, { status = null, limit = 100 } = {}) {
  const repairs = await repairStates(root);
  const byFault = new Map();
  for (const repair of repairs) {
    const list = byFault.get(repair.faultId) ?? [];
    list.push(repair);
    byFault.set(repair.faultId, list);
  }
  const faults = await directoryRecords(statePath(root, 'faults'), readFaultFile);
  return faults.map((fault) => {
    const related = (byFault.get(fault.faultId) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latest = related[0] ?? null;
    const disposition = latest?.status === 'resolved' ? 'resolved'
      : latest && JOINABLE_REPAIR_STATES.has(latest.status) ? 'repair-active'
        : 'recorded';
    return { ...fault, disposition, repair: latest ? { repairId: latest.repairId, status: latest.status } : null };
  }).filter((fault) => !status || fault.disposition === status)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 1000)));
}

function gitLines(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean) : [];
}

function statusPaths(root) {
  const commands = [
    ['diff', '--name-only', '-z', '--'],
    ['diff', '--cached', '--name-only', '-z', '--'],
    ['ls-files', '--others', '--exclude-standard', '-z']
  ];
  return [...new Set(commands.flatMap((args) => {
    const result = run('git', args, { cwd: root, allowFailure: true, encoding: 'buffer' });
    return result.status === 0 ? nulPaths(result.stdout) : [];
  }))].sort();
}

function diagnosisDisposition(fault) {
  if (['requirement', 'policy', 'architecture'].includes(fault.failure.type)) return 'challenge-intent';
  if (['configuration', 'deployment', 'production'].includes(fault.failure.type)) return 'record-environmental-deviation';
  if (['unit-test', 'integration-test', 'verification'].includes(fault.failure.type)) return 'repair-code-or-test';
  if (fault.failure.type === 'security') return 'request-strengthened-authority';
  return 'repair-code';
}

export async function diagnoseFault(root, faultId, { persist = true } = {}) {
  const fault = await readFault(root, faultId);
  const baseline = fault.build.commit;
  const baselineAvailable = run('git', ['cat-file', '-e', `${baseline}^{commit}`], { cwd: root, allowFailure: true }).status === 0;
  const parentAvailable = baselineAvailable
    && run('git', ['rev-parse', '--verify', `${baseline}^`], { cwd: root, allowFailure: true }).status === 0;
  // A root commit is not a change set. Treating every path in a large repository as implicated by
  // its first commit makes diagnosis both slow and dangerously broad; without a prior baseline,
  // report the join as unavailable and use command/dirty-path evidence only.
  const committedPaths = parentAvailable
    ? gitLines(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', `${baseline}^`, baseline])
    : [];
  const dirtyPaths = baseline === head(root) ? statusPaths(root) : [];
  const argvPaths = [];
  for (const candidate of fault.failure.commandArgv ?? []) {
    const value = String(candidate).replaceAll('\\', '/').replace(/^\.\//, '');
    if (!value.startsWith('-') && value && !path.posix.isAbsolute(value) && !value.split('/').includes('..') && await exists(path.join(root, value))) argvPaths.push(value);
  }
  const changedPaths = [...new Set([...committedPaths, ...dirtyPaths, ...argvPaths])].sort().slice(0, 1000);
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  const workflowSnapshot = await exists(workflowFile) ? await snapshot(workflowFile) : null;
  const storyCandidates = fault.story ? [
    path.join(root, 'singularity', 'work-items', fault.story, 'workflow.json'),
    path.join(root, 'singularity', 'work-items', fault.story, 'state.json')
  ] : [];
  const storyFile = (await Promise.all(storyCandidates.map(async (candidate) => await exists(candidate) ? candidate : null))).find(Boolean) ?? null;
  const storySnapshot = storyFile ? await snapshot(storyFile) : null;
  const facts = [
    { id: 'baseline', type: 'git-commit', status: baselineAvailable ? 'observed' : 'unavailable', evidence: baseline },
    { id: 'command', type: 'failure-command', status: fault.failure.command ? 'observed' : 'unavailable', evidence: fault.failure.command ?? null },
    { id: 'changed-paths', type: 'git-paths', status: changedPaths.length ? 'observed' : 'unavailable', evidence: changedPaths },
    { id: 'configuration', type: 'configuration-generation', status: workflowSnapshot ? 'observed' : 'unavailable', evidence: workflowSnapshot ? { path: 'singularity/workflow.yml', sha256: workflowSnapshot.sha256 } : null },
    { id: 'story', type: 'story-join', status: storySnapshot ? 'observed' : fault.story ? 'unavailable' : 'not-requested', evidence: storySnapshot ? { id: fault.story, path: path.relative(root, storyFile).replaceAll(path.sep, '/'), sha256: storySnapshot.sha256 } : fault.story }
  ];
  const core = {
    schemaVersion: FAULT_DIAGNOSIS_SCHEMA_VERSION,
    recordType: 'fault-diagnosis',
    faultId: fault.faultId,
    signature: fault.signature,
    createdAt: nowIso(),
    baseline: { commit: baseline, available: baselineAvailable },
    facts,
    hypotheses: [],
    affectedPaths: changedPaths,
    missingJoins: facts.filter((entry) => entry.status === 'unavailable').map((entry) => entry.id),
    disposition: diagnosisDisposition(fault),
    provenance: { mode: 'deterministic', model: null, adapter: null }
  };
  const diagnosis = withIntegrity(core);
  if (persist) {
    await withSubjectLock(root, { kind: 'fault', id: fault.faultId }, async () => {
      const hash = diagnosis.integrity.sha256;
      await immutableWrite(root, statePath(root, 'diagnoses', fault.faultId, `${hash}.json`), diagnosis, `Diagnosis '${hash}'`);
      await safeWrite(root, statePath(root, 'diagnoses', fault.faultId, 'latest.json'), {
        schemaVersion: 1, faultId: fault.faultId, diagnosisSha256: hash, updatedAt: nowIso()
      });
    });
  }
  return diagnosis;
}

function requestedCeiling(mode, fault) {
  if (mode && mode !== 'policy-decides') return mode;
  if (fault.requestedAction && fault.requestedAction !== 'policy-decides') return fault.requestedAction;
  return 'bounded-auto';
}

export function effectiveRepairPolicy(fault, configuredPolicy = {}, {
  mode = 'policy-decides', maxAttempts = null, executionEnvironment = fault.environment
} = {}) {
  const policy = normalizeFaultRepairPolicy(configuredPolicy);
  if (maxAttempts != null && (!Number.isInteger(Number(maxAttempts)) || Number(maxAttempts) < 1)) {
    throw new SingularityFlowError('maxAttempts must be a positive integer.', { code: 'REPAIR_BUDGET_INVALID' });
  }
  if (!ENVIRONMENTS.has(executionEnvironment)) {
    throw new SingularityFlowError(`Unknown repair execution environment '${executionEnvironment}'.`, { code: 'FAULT_ENVIRONMENT_INVALID' });
  }
  let ceiling = policy.environmentCeilings[executionEnvironment] ?? 'record';
  if (fault.environment === 'production' || fault.failure.type === 'production') ceiling = 'diagnose';
  if (['security', 'requirement', 'policy', 'architecture'].includes(fault.failure.type)) ceiling = 'diagnose';
  if (!policy.boundedAuto && ceiling === 'bounded-auto') ceiling = 'guided';
  const requested = requestedCeiling(mode, fault);
  const effectiveIndex = Math.min(ACTION_CEILINGS.indexOf(ceiling), ACTION_CEILINGS.indexOf(requested));
  return Object.freeze({
    ceiling: ACTION_CEILINGS[Math.max(0, effectiveIndex)],
    observationEnvironment: fault.environment,
    executionEnvironment,
    requested,
    policyCeiling: ceiling,
    maxAttempts: Math.min(policy.maxAttempts, maxAttempts == null ? policy.maxAttempts : Number(maxAttempts)),
    maxMinutes: policy.maxMinutes,
    maxTokens: policy.maxTokens,
    leaseMinutes: policy.leaseMinutes,
    protectedPaths: [...policy.protectedPaths],
    policyHash: `sha256:${recordHash(policy)}`
  });
}

/** Parse a verification command without invoking a shell or accepting shell operators. */
export function parseVerificationCommand(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new SingularityFlowError('Verification command is empty.', { code: 'REPAIR_VERIFICATION_INVALID' });
  const argv = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\' && quote !== "'") {
      const next = text[index + 1];
      // Preserve ordinary Windows path separators. Backslash is an escape only where it has an
      // unambiguous quoting purpose; `C:\Program Files\node.exe` must remain byte-for-byte intact.
      if (next === quote || (!quote && (next === '"' || next === "'" || next === '\\' || /\s/.test(next ?? '')))) {
        current += next;
        index += 1;
      } else current += character;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) { if (current) { argv.push(current); current = ''; } continue; }
    if ('|;&><`'.includes(character) || character === '\n' || character === '\r') {
      throw new SingularityFlowError('Verification commands must be argv, not shell expressions.', { code: 'REPAIR_VERIFICATION_INVALID' });
    }
    current += character;
  }
  if (quote) throw new SingularityFlowError('Verification command has an unterminated quote.', { code: 'REPAIR_VERIFICATION_INVALID' });
  if (current) argv.push(current);
  if (!argv.length) throw new SingularityFlowError('Verification command is empty.', { code: 'REPAIR_VERIFICATION_INVALID' });
  return argv;
}

/** Structured CLI input avoids every platform's shell-string quoting rules. */
export function parseVerificationArgv(value, label = 'verification argv') {
  let parsed;
  try { parsed = JSON.parse(String(value ?? '')); }
  catch (error) {
    throw new SingularityFlowError(`${label} must be a JSON array of strings: ${error.message}`, {
      code: 'REPAIR_VERIFICATION_INVALID'
    });
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((entry) => typeof entry !== 'string')) {
    throw new SingularityFlowError(`${label} must be a non-empty JSON array of strings.`, {
      code: 'REPAIR_VERIFICATION_INVALID'
    });
  }
  return parsed;
}

const FORBIDDEN_VERIFICATION_PROGRAMS = new Set([
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'telnet', 'gh',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'ansible', 'rsync',
  'rm', 'rmdir', 'del', 'erase', 'shred', 'shutdown', 'reboot'
]);
const SAFE_GIT_VERBS = new Set(['cat-file', 'diff', 'diff-tree', 'grep', 'log', 'ls-files', 'rev-parse', 'show', 'status']);

function validateVerificationArgv(argv, label = 'verification command') {
  if (!Array.isArray(argv) || !argv.length) {
    throw new SingularityFlowError(`${label} must be a non-empty argv array.`, { code: 'REPAIR_VERIFICATION_INVALID' });
  }
  const normalized = argv.map((entry) => requireText(entry, `${label} argv`, { maximum: 4096 }));
  const program = path.basename(normalized[0]).toLowerCase().replace(/\.exe$/, '');
  if (FORBIDDEN_VERIFICATION_PROGRAMS.has(program)) {
    throw new SingularityFlowError(`${label} may not invoke '${program}'.`, { code: 'REPAIR_VERIFICATION_UNSAFE' });
  }
  if (['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'].includes(program)) {
    throw new SingularityFlowError(`${label} may not invoke a command shell.`, { code: 'REPAIR_VERIFICATION_UNSAFE' });
  }
  if (program === 'git' && !SAFE_GIT_VERBS.has(normalized[1] ?? '')) {
    throw new SingularityFlowError(`${label} may not run mutating or remote Git command '${normalized[1] ?? ''}'.`, { code: 'REPAIR_VERIFICATION_UNSAFE' });
  }
  if (['npm', 'pnpm', 'yarn'].includes(program)
    && normalized.slice(1).some((entry) => ['publish', 'login', 'adduser', 'logout'].includes(entry.toLowerCase()))) {
    throw new SingularityFlowError(`${label} may not publish or alter registry credentials.`, { code: 'REPAIR_VERIFICATION_UNSAFE' });
  }
  return normalized;
}

function verificationPlan(fault, supplied = []) {
  if (!Array.isArray(supplied)) {
    throw new SingularityFlowError('verification must be an array.', { code: 'REPAIR_VERIFICATION_INVALID' });
  }
  const commands = supplied.length
    ? supplied.map((entry) => Array.isArray(entry) ? entry.map(String) : parseVerificationCommand(entry))
    : fault.failure.commandArgv ? [fault.failure.commandArgv.map(String)] : [];
  return commands.map((argv, index) => ({
    id: `verify-${index + 1}`,
    argv: validateVerificationArgv(argv, `verification[${index}]`),
    required: true
  }));
}

function planStatus(ceiling, adequate) {
  if (ceiling === 'record') return 'recorded';
  if (ceiling === 'diagnose') return 'diagnosis-ready';
  if (!adequate) return 'needs-human';
  if (ceiling === 'propose') return 'proposed';
  // No autonomous mutation adapter ships in core. A policy may permit bounded automation, but
  // permission alone is not an executor; stop visibly instead of silently behaving as guided.
  if (ceiling === 'bounded-auto') return 'needs-human';
  return 'awaiting-authorization';
}

function publicPlanCore({ repairId, fault, diagnosis, effective, allowedPaths, verification }) {
  const diagnosisCore = withoutIntegrity(diagnosis);
  const sandbox = verificationSandboxKind();
  const wrapperAvailable = sandbox !== 'disposable-worktree-only';
  return {
    schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
    recordType: 'repair-plan',
    repairId,
    faultId: fault.faultId,
    signature: fault.signature,
    createdAt: nowIso(),
    goal: fault.failure.message ?? `Repair ${fault.failure.type} fault ${fault.faultId}`,
    baseline: fault.build.commit,
    intent: diagnosis.facts.find((entry) => entry.id === 'story')?.evidence ?? null,
    allowedPaths,
    prohibitedPaths: effective.protectedPaths,
    verification,
    budgets: { maxAttempts: effective.maxAttempts, maxMinutes: effective.maxMinutes, maxTokens: effective.maxTokens },
    executionMode: effective.ceiling,
    observationEnvironment: effective.observationEnvironment,
    executionEnvironment: effective.executionEnvironment,
    requestedMode: effective.requested,
    tools: {
      commands: verification.map((entry) => entry.argv),
      sandbox,
      network: wrapperAvailable ? 'denied' : 'host-not-isolated',
      // Both shipped OS wrappers permit host reads needed by runtimes and libraries. They constrain
      // writes and network; claiming external files were unreadable would be a security defect.
      externalFilesystem: wrapperAvailable ? 'host-read-permitted; external-writes-denied' : 'host-not-isolated',
      commandTrust: 'explicit-plan-confirmation; maintainer-reviewed-verifiers-only',
      environmentNames: ['CI', 'HOME', 'NODE_ENV', 'PATH', 'TMPDIR'],
      capabilities: [
        'read-scoped-context', 'apply-validated-patch',
        'run-pinned-verification-in-disposable-worktree'
      ]
    },
    escalation: [
      'scope-expansion', 'protected-path', 'baseline-change', 'verification-unavailable',
      'no-progress', 'patch-oscillation', 'budget-exhausted', 'intent-conflict'
    ],
    policyHash: effective.policyHash,
    diagnosisSha256: diagnosis.integrity.sha256,
    // Diagnosis records retain when they were observed; plan equivalence follows the facts rather
    // than that clock so repeating an identical request joins instead of silently minting authority.
    diagnosisSemanticSha256: recordHash({ ...diagnosisCore, createdAt: null })
  };
}

async function writeRepairEvent(root, state, type, data = {}) {
  const sequence = (state.events ?? 0) + 1;
  const core = {
    schemaVersion: 1, recordType: 'repair-event', repairId: state.repairId,
    sequence, type, at: nowIso(), data
  };
  const event = withIntegrity(core);
  await immutableWrite(root, statePath(root, 'repairs', state.repairId, 'events', `${String(sequence).padStart(4, '0')}-${event.integrity.sha256}.json`), event, `Repair event ${sequence}`);
  state.events = sequence;
  return event;
}

async function saveRepairState(root, state) {
  state.updatedAt = nowIso();
  const stored = withIntegrity(withoutIntegrity(state));
  await safeWrite(root, statePath(root, 'repairs', state.repairId, 'state.json'), stored);
  return stored;
}

function planFileName(generation, sha) {
  return `${String(generation).padStart(3, '0')}-${sha}.json`;
}

async function persistRepairPlan(root, repairId, plan, generation = 1) {
  const file = statePath(root, 'repairs', repairId, 'plans', planFileName(generation, plan.integrity.sha256));
  await immutableWrite(root, file, plan, `Repair plan '${repairId}' generation ${generation}`);
  // Retain the initial public path for compatibility, but never use it as the only authority root.
  if (generation === 1) {
    await immutableWrite(root, statePath(root, 'repairs', repairId, 'plan.json'), plan, `Repair plan '${repairId}'`);
  }
  return file;
}

async function verifiedCurrentPlan(root, state) {
  verifyIntegrity(state.plan, `RepairPlan '${state.repairId}' state projection`);
  const generation = state.planGeneration ?? 1;
  const modern = statePath(
    root, 'repairs', state.repairId, 'plans', planFileName(generation, state.plan.integrity.sha256)
  );
  const legacy = statePath(root, 'repairs', state.repairId, 'plan.json');
  const file = await exists(modern) ? modern : legacy;
  const immutable = requireSchema(await readJson(file), REPAIR_PLAN_SCHEMA_VERSION, `RepairPlan '${state.repairId}'`);
  if (immutable.integrity.sha256 !== state.plan.integrity.sha256
    || canonicalJson(immutable) !== canonicalJson(state.plan)) {
    throw new SingularityFlowError(`Repair '${state.repairId}' plan differs from its immutable plan record.`, { code: 'REPAIR_PLAN_CHANGED' });
  }
  return immutable;
}

function planDecisionCore(plan) {
  return {
    baseline: plan.baseline,
    intent: plan.intent,
    allowedPaths: plan.allowedPaths,
    prohibitedPaths: plan.prohibitedPaths,
    verification: plan.verification,
    budgets: plan.budgets,
    executionMode: plan.executionMode,
    requestedMode: plan.requestedMode,
    policyHash: plan.policyHash,
    diagnosisSemanticSha256: plan.diagnosisSemanticSha256 ?? plan.diagnosisSha256
  };
}

export async function readRepair(root, repairId) {
  const id = requireId(repairId, 'RPR', 'repairId');
  return requireSchema(await readJson(statePath(root, 'repairs', id, 'state.json')), REPAIR_STATE_SCHEMA_VERSION, 'RepairState');
}

export async function listRepairs(root, { status = null } = {}) {
  return (await repairStates(root)).filter((entry) => !status || entry.status === status)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function requestRepair(root, faultId, {
  mode = 'policy-decides', maxAttempts = null, allowedPaths = [], verification = [],
  policy: configuredPolicy = {}, persist = true, executionEnvironment = null
} = {}) {
  const fault = await readFault(root, faultId);
  if (!Array.isArray(allowedPaths)) {
    throw new SingularityFlowError('allowedPaths must be an array.', { code: 'REPAIR_SCOPE_INVALID' });
  }
  const diagnosis = await diagnoseFault(root, fault.faultId, { persist });
  const effective = effectiveRepairPolicy(fault, configuredPolicy, {
    mode,
    maxAttempts,
    executionEnvironment: executionEnvironment ?? fault.environment
  });
  // Diagnosis paths are evidence and may include an entire baseline commit or unrelated dirty
  // files. Only an explicitly reviewed allow-path can become mutation authority.
  const paths = [...new Set(allowedPaths.map((entry) => normalizePathPrefix(entry, 'allowed path')))].sort();
  const checks = verificationPlan(fault, verification);
  const adequate = paths.length > 0 && checks.length > 0 && diagnosis.disposition !== 'challenge-intent';

  return withSubjectLock(root, { kind: 'repair-signature', id: fault.signature }, async () => {
    let active = null;
    if (persist) {
      active = (await repairStates(root)).find((entry) => entry.signature === fault.signature
        && entry.baseline === fault.build.commit && JOINABLE_REPAIR_STATES.has(entry.status));
    }
    const repairId = active?.repairId ?? (persist ? nextId('RPR') : `RPR-PREVIEW-${fault.faultId.slice(4)}`);
    const plan = withIntegrity(publicPlanCore({ repairId, fault, diagnosis, effective, allowedPaths: paths, verification: checks }));
    const status = diagnosis.disposition === 'challenge-intent'
      ? 'challenge-required'
      : planStatus(effective.ceiling, adequate);
    if (active) {
      await verifiedCurrentPlan(root, active);
      if (canonicalJson(planDecisionCore(active.plan)) === canonicalJson(planDecisionCore(plan))) {
        return { repair: active, plan: active.plan, diagnosis, joined: true, persisted: true };
      }
      const replannable = !active.workspace && !(active.attempts?.length)
        && ['recorded', 'diagnosis-ready', 'proposed', 'needs-human', 'awaiting-authorization',
          'challenge-required', 'challenge-opened'].includes(active.status);
      if (!replannable) {
        throw new SingularityFlowError(
          `Repair '${active.repairId}' already has active authority or attempts. Cancel it before changing scope, verification, or execution context.`,
          { code: 'REPAIR_REPLAN_REQUIRES_CANCELLATION' }
        );
      }
      const priorSha256 = active.plan.integrity.sha256;
      const generation = (active.planGeneration ?? 1) + 1;
      await persistRepairPlan(root, active.repairId, plan, generation);
      active.plan = plan;
      active.planGeneration = generation;
      active.planHistory = [
        ...(active.planHistory ?? [{ generation: 1, sha256: priorSha256 }]),
        { generation, sha256: plan.integrity.sha256 }
      ];
      active.status = status;
      active.executionMode = effective.ceiling;
      active.policy = effective;
      active.stopReason = diagnosis.disposition === 'challenge-intent' ? 'intent-conflict'
        : !paths.length ? 'scope-required'
          : !checks.length ? 'verification-required'
            : effective.ceiling === 'bounded-auto' ? 'adapter-authorization-required' : null;
      active.finalDisposition = null;
      await writeRepairEvent(root, active, 'repair-replanned', {
        generation, priorPlanSha256: priorSha256, planSha256: plan.integrity.sha256,
        executionEnvironment: effective.executionEnvironment, status
      });
      const stored = await saveRepairState(root, active);
      return { repair: stored, plan, diagnosis, joined: false, replanned: true, persisted: true };
    }
    const state = {
      schemaVersion: REPAIR_STATE_SCHEMA_VERSION,
      recordType: 'repair-state',
      repairId,
      faultId: fault.faultId,
      signature: fault.signature,
      baseline: fault.build.commit,
      status,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
      executionMode: effective.ceiling,
      policy: effective,
      plan,
      planGeneration: 1,
      planHistory: [{ generation: 1, sha256: plan.integrity.sha256 }],
      attempts: [],
      events: 0,
      lease: null,
      workspace: null,
      finalDisposition: null,
      stopReason: diagnosis.disposition === 'challenge-intent' ? 'intent-conflict'
        : !paths.length ? 'scope-required'
          : !checks.length ? 'verification-required'
            : effective.ceiling === 'bounded-auto' ? 'adapter-authorization-required' : null
    };
    if (!persist) return { repair: withIntegrity(state), plan, diagnosis, joined: false, persisted: false };
    await persistRepairPlan(root, repairId, plan, 1);
    await writeRepairEvent(root, state, 'repair-requested', {
      status, executionMode: effective.ceiling, diagnosisSha256: diagnosis.integrity.sha256
    });
    if (TERMINAL_REPAIR_STATES.has(status)) {
      const receipt = await terminalReceipt(root, state, status, state.stopReason);
      state.finalDisposition = { status, receiptSha256: receipt.integrity.sha256 };
    }
    const stored = await saveRepairState(root, state);
    return { repair: stored, plan, diagnosis, joined: false, persisted: true };
  });
}

function repairBranch(repairId) {
  return `sflow/repair/${repairId.toLowerCase()}`;
}

function repairWorktree(root, repairId) {
  return statePath(root, 'worktrees', repairId);
}

function actorKey(actor) {
  return actor.email ?? actor.login ?? actor.subject;
}

function newLease(root, state) {
  const actor = normalizedActor(root);
  return {
    leaseId: `RLS-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
    actor: actorKey(actor),
    acquiredAt: nowIso(),
    expiresAt: new Date(Date.now() + state.policy.leaseMinutes * 60_000).toISOString()
  };
}

function assertLease(root, state) {
  if (!state.lease || Date.parse(state.lease.expiresAt) <= Date.now()) {
    throw new SingularityFlowError(`Repair '${state.repairId}' authorization lease expired. Authorize the plan again.`, { code: 'REPAIR_LEASE_EXPIRED' });
  }
  const actor = normalizedActor(root);
  if (state.lease.actor !== actorKey(actor)) {
    throw new SingularityFlowError(`Repair '${state.repairId}' is leased to another identity.`, { code: 'REPAIR_LEASE_HELD' });
  }
  state.lease = { ...state.lease, expiresAt: new Date(Date.now() + state.policy.leaseMinutes * 60_000).toISOString() };
}

function commitObjectId(root, value) {
  return run('git', ['rev-parse', '--verify', `${value}^{commit}`], { cwd: root, allowFailure: true }).stdout.trim() || null;
}

async function verifiedRepairEvents(root, repairId) {
  return directoryRecords(
    statePath(root, 'repairs', repairId, 'events'),
    async (file) => verifyIntegrity(await readJson(file), 'RepairEvent')
  );
}

export async function authorizeRepair(root, repairId, { confirmation, open = false } = {}) {
  const id = requireId(repairId, 'RPR', 'repairId');
  return withSubjectLock(root, { kind: 'repair', id }, async () => {
    let state = await readRepair(root, id);
    if (!['awaiting-authorization', 'retry-ready'].includes(state.status)) {
      throw new SingularityFlowError(`Repair '${id}' cannot be authorized from '${state.status}'.`, { code: 'REPAIR_STATE_INVALID' });
    }
    if (state.executionMode !== 'guided') {
      throw new SingularityFlowError(`Repair '${id}' is '${state.executionMode}' and cannot mutate.`, { code: 'REPAIR_POLICY_DENIED' });
    }
    const plan = await verifiedCurrentPlan(root, state);
    const expected = plan.integrity.sha256;
    if (confirmation !== expected && confirmation !== `sha256:${expected}`) {
      throw new SingularityFlowError(`Authorization must confirm the exact plan hash '${expected}'.`, { code: 'REPAIR_CONFIRMATION_MISMATCH' });
    }
    const currentHead = commitObjectId(root, 'HEAD');
    const baseline = commitObjectId(root, state.baseline);
    if (!baseline || currentHead !== baseline) {
      throw new SingularityFlowError(`Repository HEAD moved from repair baseline ${state.baseline} to ${head(root)}. Create a new plan.`, { code: 'REPAIR_BASELINE_CHANGED' });
    }
    if (state.status === 'retry-ready') {
      if (!state.workspace?.path || !await exists(state.workspace.path)) {
        throw new SingularityFlowError(`Repair '${id}' isolated worktree is unavailable.`, { code: 'REPAIR_WORKTREE_UNAVAILABLE' });
      }
      state.lease = newLease(root, state);
      state.status = 'awaiting-patch';
      state.stopReason = null;
      await writeRepairEvent(root, state, 'repair-authorized', {
        planSha256: expected, actor: state.lease.actor, leaseId: state.lease.leaseId,
        branch: state.workspace.branch, attempt: state.attempts.length + 1
      });
      state = await saveRepairState(root, state);
      let opened = false;
      if (open) {
        const launched = run('code', ['--reuse-window', state.workspace.path], { cwd: root, allowFailure: true });
        opened = launched.status === 0;
      }
      return { repair: state, opened };
    }
    const worktree = repairWorktree(root, id);
    const repairBranchName = repairBranch(id);
    if (await exists(worktree) || run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${repairBranchName}`], { cwd: root, allowFailure: true }).status === 0) {
      throw new SingularityFlowError(`Repair workspace or branch already exists for '${id}'.`, { code: 'REPAIR_WORKSPACE_EXISTS' });
    }
    await safeDirectory(path.dirname(worktree), stateRoot(root));
    state.status = 'authorizing';
    await saveRepairState(root, state);
    const created = run('git', ['worktree', 'add', '-b', repairBranchName, worktree, state.baseline], { cwd: root, allowFailure: true });
    if (created.status !== 0) {
      state.status = 'awaiting-authorization';
      state.stopReason = 'worktree-create-failed';
      await saveRepairState(root, state);
      throw new SingularityFlowError(`Unable to create isolated repair worktree: ${created.stderr.trim()}`, { code: 'REPAIR_WORKTREE_FAILED' });
    }
    state.workspace = { path: worktree, branch: repairBranchName, baseline: state.baseline, published: false };
    state.lease = newLease(root, state);
    state.status = 'awaiting-patch';
    state.stopReason = null;
    await writeRepairEvent(root, state, 'repair-authorized', {
      planSha256: expected, actor: state.lease.actor, leaseId: state.lease.leaseId,
      branch: repairBranchName
    });
    state = await saveRepairState(root, state);
    let opened = false;
    if (open) {
      const launched = run('code', ['--reuse-window', worktree], { cwd: root, allowFailure: true });
      opened = launched.status === 0;
    }
    return { repair: state, opened };
  });
}

function patchPaths(patch) {
  if (/^(?:new file mode|old mode|new mode) 120000$/m.test(patch)) {
    throw new SingularityFlowError('Repair patches may not create or change symbolic links.', { code: 'REPAIR_PATCH_UNSAFE' });
  }
  const paths = [];
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    for (const raw of [match[1], match[2]]) {
      if (raw.startsWith('"') || raw.includes('\t')) throw new SingularityFlowError('Quoted or tabbed patch paths are not supported.', { code: 'REPAIR_PATCH_UNSAFE' });
      paths.push(normalizePathPrefix(raw, 'patch path'));
    }
  }
  if (!paths.length) throw new SingularityFlowError('Patch contains no Git file changes.', { code: 'REPAIR_PATCH_INVALID' });
  return [...new Set(paths)].sort();
}

function validatePatchScope(paths, plan) {
  const outside = paths.filter((candidate) => !plan.allowedPaths.some((prefix) => pathInside(candidate, prefix)));
  const prohibited = paths.filter((candidate) => plan.prohibitedPaths.some((prefix) => pathInside(candidate, prefix)));
  if (outside.length || prohibited.length) {
    throw new SingularityFlowError(
      `Repair patch is outside the authorized scope.${outside.length ? ` Outside: ${outside.join(', ')}.` : ''}${prohibited.length ? ` Prohibited: ${prohibited.join(', ')}.` : ''}`,
      { code: 'REPAIR_SCOPE_VIOLATION', details: { outside, prohibited } }
    );
  }
}

function boundedOutput(value, limit = 64 * 1024) {
  const source = Buffer.from(String(value ?? ''), 'utf8');
  const sanitized = sanitizeFaultText(source.toString('utf8')).text;
  const bytes = Buffer.from(sanitized, 'utf8');
  return {
    sha256: `sha256:${sha256(bytes)}`,
    bytes: bytes.length,
    excerpt: bytes.subarray(0, limit).toString('utf8'),
    truncated: bytes.length > limit
  };
}

function nulPaths(value) {
  return Buffer.from(value).toString('utf8').split('\0').filter(Boolean).map((entry) => entry.replaceAll('\\', '/'));
}

async function repairWorktreeSnapshot(worktree, baseline) {
  const diff = run('git', ['diff', '--binary', '--no-ext-diff', baseline, '--'], {
    cwd: worktree, encoding: 'buffer'
  }).stdout;
  const tracked = nulPaths(run('git', ['diff', '--name-only', '-z', baseline, '--'], {
    cwd: worktree, encoding: 'buffer'
  }).stdout);
  const untracked = nulPaths(run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: worktree, encoding: 'buffer'
  }).stdout);
  const untrackedFiles = [];
  for (const relative of untracked.sort()) {
    const absolute = path.join(worktree, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new SingularityFlowError(`Repair worktree contains unsafe untracked path '${relative}'.`, { code: 'REPAIR_UNEXPECTED_MUTATION' });
    }
    const bytes = await readFile(absolute);
    untrackedFiles.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const core = {
    diffSha256: sha256(diff),
    untracked: untrackedFiles,
    changedPaths: [...new Set([...tracked, ...untracked])].sort()
  };
  return { ...core, sha256: `sha256:${recordHash(core)}` };
}

function verificationEnvironment(scratch) {
  const selected = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'ComSpec', 'PATHEXT']) {
    if (process.env[name]) selected[name] = process.env[name];
  }
  return {
    ...selected,
    CI: 'true',
    NODE_ENV: 'test',
    HOME: scratch,
    USERPROFILE: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    SINGULARITY_FLOW_REPAIR_NO_RECURSION: '1'
  };
}

function sandboxString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function verificationSandboxKind({ platform = process.platform, execute = run } = {}) {
  if (platform === 'darwin') {
    const probe = execute('/usr/bin/sandbox-exec', [
      '-p', '(version 1) (allow default)', '--', '/usr/bin/true'
    ], { allowFailure: true });
    if (probe.status === 0) return 'macos-sandbox';
  }
  if (platform === 'linux') {
    const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find((candidate) =>
      execute(candidate, [
        '--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true'
      ], { allowFailure: true }).status === 0);
    if (bwrap) return `bubblewrap:${bwrap}`;
  }
  return 'disposable-worktree-only';
}

function verificationInvocation(argv, worktree, scratch, expectedSandbox = null) {
  const sandbox = verificationSandboxKind();
  if (expectedSandbox && sandbox !== expectedSandbox) return null;
  if (sandbox === 'macos-sandbox') {
    // macOS presents /var as /private/var inside the sandbox namespace. Authorize both spellings so
    // a temporary Git worktree remains writable without opening any other filesystem location.
    const writable = [...new Set([worktree, scratch].flatMap((entry) =>
      entry.startsWith('/var/') ? [entry, `/private${entry}`] : [entry]))]
      .map((entry) => `(subpath "${sandboxString(entry)}")`).join(' ');
    const profile = `(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow file-read*)\n(allow file-write* ${writable})\n(deny network*)`;
    return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, '--', ...argv], sandbox: 'macos-sandbox' };
  }
  if (sandbox.startsWith('bubblewrap:')) {
    const bwrap = sandbox.slice('bubblewrap:'.length);
    return {
      command: bwrap,
      args: [
        '--die-with-parent', '--unshare-net', '--ro-bind', '/', '/',
        '--bind', worktree, worktree, '--bind', scratch, scratch,
        '--chdir', worktree, '--', ...argv
      ],
      sandbox: 'bubblewrap'
    };
  }
  return { command: argv[0], args: argv.slice(1), sandbox: 'disposable-worktree-only' };
}

async function runVerificationSet(root, state, patch, attemptNumber, deadline) {
  const parent = statePath(root, 'verification');
  await safeDirectory(parent, stateRoot(root));
  const worktree = path.join(parent, `${state.repairId}-${String(attemptNumber).padStart(3, '0')}`);
  const scratch = path.join(parent, `${state.repairId}-${String(attemptNumber).padStart(3, '0')}-scratch`);
  if (await exists(worktree)) {
    run('git', ['worktree', 'remove', '--force', worktree], { cwd: root, allowFailure: true });
    await rm(worktree, { recursive: true, force: true });
  }
  await safeDirectory(scratch, stateRoot(root));
  const created = run('git', ['worktree', 'add', '--detach', worktree, state.baseline], { cwd: root, allowFailure: true });
  if (created.status !== 0) {
    await rm(worktree, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
    return state.plan.verification.map((command) => ({
      id: command.id, argv: command.argv, status: 'unavailable', reason: 'verification-worktree-unavailable'
    }));
  }
  const verification = [];
  try {
    const applied = run('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: worktree, allowFailure: true, input: patch
    });
    if (applied.status !== 0) {
      return state.plan.verification.map((command) => ({
        id: command.id, argv: command.argv, status: 'unavailable', reason: 'verification-patch-unavailable'
      }));
    }
    for (const command of state.plan.verification) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        verification.push({ id: command.id, argv: command.argv, status: 'unavailable', reason: 'time-budget-exhausted' });
        break;
      }
      const invocation = verificationInvocation(
        command.argv, worktree, scratch, state.plan.tools?.sandbox ?? null
      );
      if (!invocation) {
        verification.push({
          id: command.id, argv: command.argv, status: 'unavailable', reason: 'verification-sandbox-changed'
        });
        break;
      }
      const result = run(invocation.command, invocation.args, {
        cwd: worktree,
        allowFailure: true,
        timeoutMs: remaining,
        env: {
          ...verificationEnvironment(scratch),
          SINGULARITY_FLOW_REPAIR_ID: state.repairId
        }
      });
      verification.push({
        id: command.id, argv: command.argv, sandbox: invocation.sandbox,
        status: result.status === 0 ? 'passed' : 'failed',
        exitCode: result.status, signal: result.signal,
        stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr),
        timedOut: result.timedOut === true
      });
    }
    return verification;
  } finally {
    run('git', ['worktree', 'remove', '--force', worktree], { cwd: root, allowFailure: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

async function terminalReceipt(root, state, disposition, reason) {
  const fault = await readFault(root, state.faultId);
  const diagnosis = state.plan.diagnosisSha256
    ? await readJson(statePath(root, 'diagnoses', state.faultId, `${state.plan.diagnosisSha256}.json`)).then((record) => verifyIntegrity(record, 'FaultDiagnosis'))
    : null;
  const attemptRecords = await directoryRecords(
    statePath(root, 'repairs', state.repairId, 'attempts'),
    async (file) => verifyIntegrity(await readJson(file), 'RepairAttempt')
  );
  const completedAt = nowIso();
  const elapsedMinutes = Math.max(0, (Date.parse(completedAt) - Date.parse(state.plan.createdAt)) / 60_000);
  const core = {
    schemaVersion: REPAIR_RECEIPT_SCHEMA_VERSION,
    recordType: 'repair-receipt',
    repairId: state.repairId,
    faultId: state.faultId,
    signature: state.signature,
    occurrenceGroup: fault.occurrenceGroup,
    baseline: state.baseline,
    baselines: {
      build: fault.build,
      story: fault.story,
      capability: fault.capability,
      configuration: diagnosis?.facts.find((entry) => entry.id === 'configuration')?.evidence ?? null,
      specification: diagnosis?.facts.find((entry) => entry.id === 'story')?.evidence ?? null
    },
    authoritySnapshot: fault.identity.authoritySnapshot,
    planSha256: state.plan.integrity.sha256,
    planGenerations: state.planHistory ?? [{ generation: state.planGeneration ?? 1, sha256: state.plan.integrity.sha256 }],
    policy: state.policy,
    diagnosis: diagnosis ? {
      sha256: diagnosis.integrity.sha256,
      facts: diagnosis.facts,
      hypotheses: diagnosis.hypotheses,
      disposition: diagnosis.disposition,
      provenance: diagnosis.provenance
    } : null,
    attempts: attemptRecords.map((attempt) => ({
      attempt: attempt.attempt,
      sha256: attempt.integrity.sha256,
      patchSha256: attempt.patchSha256,
      diffSha256: attempt.diffSha256,
      worktreeSha256: attempt.worktreeSha256 ?? attempt.diffSha256,
      touchedPaths: attempt.touchedPaths,
      changedPaths: attempt.changedPaths ?? attempt.touchedPaths,
      verification: attempt.verification,
      outcome: attempt.outcome,
      model: attempt.model,
      adapter: attempt.adapter
    })),
    budgetConsumption: {
      attempts: state.attempts.length,
      maximumAttempts: state.plan.budgets.maxAttempts,
      elapsedMinutes,
      maximumMinutes: state.plan.budgets.maxMinutes,
      tokens: 0,
      maximumTokens: state.plan.budgets.maxTokens
    },
    humanDecisions: (await verifiedRepairEvents(root, state.repairId))
      .filter((event) => ['repair-authorized', 'repair-cancelled'].includes(event.type))
      .map((event) => ({ type: event.type, at: event.at, actor: event.data.actor ?? null, reason: event.data.reason ?? null })),
    finalDisposition: disposition,
    reason,
    completedAt,
    preservation: {
      developerWorktree: 'untouched',
      isolatedWorktree: state.workspace?.path ? 'preserved' : 'not-created',
      remoteRefs: 'unchanged'
    },
    model: null,
    adapter: null
  };
  const receipt = withIntegrity(core);
  await immutableWrite(root, statePath(root, 'repairs', state.repairId, 'receipts', `${receipt.integrity.sha256}.json`), receipt, `Repair receipt '${state.repairId}'`);
  return receipt;
}

export async function attemptRepair(root, repairId, { patchFile } = {}) {
  const id = requireId(repairId, 'RPR', 'repairId');
  const patchPath = path.resolve(requireText(patchFile, 'patch file', { maximum: 4096 }));
  const patchInfo = await stat(patchPath);
  if (!patchInfo.isFile() || patchInfo.size > 2 * 1024 * 1024) throw new SingularityFlowError('Repair patch must be a regular file no larger than 2 MiB.', { code: 'REPAIR_PATCH_INVALID' });
  const patch = await readFile(patchPath, 'utf8');
  const touched = patchPaths(patch);
  return withSubjectLock(root, { kind: 'repair', id }, async () => {
    let state = await readRepair(root, id);
    if (state.status !== 'awaiting-patch') {
      throw new SingularityFlowError(`Repair '${id}' cannot accept a patch from '${state.status}'.`, { code: 'REPAIR_STATE_INVALID' });
    }
    assertLease(root, state);
    const plan = await verifiedCurrentPlan(root, state);
    const authorizations = (await verifiedRepairEvents(root, id)).filter((event) => event.type === 'repair-authorized');
    const authorization = authorizations.at(-1);
    if (!authorization || authorization.data.planSha256 !== plan.integrity.sha256
      || authorization.data.leaseId !== state.lease.leaseId) {
      throw new SingularityFlowError(`Repair '${id}' has no current authorization for its immutable plan and lease.`, { code: 'REPAIR_AUTHORIZATION_INVALID' });
    }
    validatePatchScope(touched, plan);
    if (!state.workspace?.path || !await exists(state.workspace.path)) throw new SingularityFlowError(`Repair '${id}' isolated worktree is unavailable.`, { code: 'REPAIR_WORKTREE_UNAVAILABLE' });
    if (commitObjectId(state.workspace.path, 'HEAD') !== commitObjectId(root, state.baseline)) {
      throw new SingularityFlowError(`Repair '${id}' baseline changed before patch application.`, { code: 'REPAIR_BASELINE_CHANGED' });
    }
    const existingSnapshot = await repairWorktreeSnapshot(state.workspace.path, state.baseline);
    if (!state.attempts.length && existingSnapshot.changedPaths.length) {
      throw new SingularityFlowError(`Repair '${id}' worktree changed outside the kernel attempt path.`, { code: 'REPAIR_UNEXPECTED_MUTATION' });
    }
    if (state.attempts.length) {
      const priorAttempt = state.attempts.at(-1);
      const currentMatches = priorAttempt?.worktreeSha256
        ? existingSnapshot.sha256 === priorAttempt.worktreeSha256
        : existingSnapshot.untracked.length === 0
          && `sha256:${sha256(run('git', ['diff', '--binary', state.baseline, '--'], { cwd: state.workspace.path }).stdout)}` === priorAttempt?.diffSha256;
      if (!currentMatches) {
        throw new SingularityFlowError(`Repair '${id}' worktree changed after its previous attempt.`, { code: 'REPAIR_UNEXPECTED_MUTATION' });
      }
      // This is the isolated repair worktree, and the exact previous diff is already immutable in
      // the attempt record. Starting the next candidate from the pinned baseline prevents patches
      // from accumulating authority across attempts.
      run('git', ['reset', '--hard', state.baseline], { cwd: state.workspace.path });
      run('git', ['clean', '-fdx'], { cwd: state.workspace.path });
    }
    const check = run('git', ['apply', '--check', '--whitespace=error-all', '-'], { cwd: state.workspace.path, allowFailure: true, input: patch });
    if (check.status !== 0) throw new SingularityFlowError(`Repair patch does not apply cleanly: ${check.stderr.trim()}`, { code: 'REPAIR_PATCH_INVALID' });
    state.status = 'repairing';
    await saveRepairState(root, state);
    const applied = run('git', ['apply', '--whitespace=nowarn', '-'], { cwd: state.workspace.path, allowFailure: true, input: patch });
    if (applied.status !== 0) {
      state.status = 'quarantined';
      state.stopReason = 'patch-application-failed-after-check';
      await writeRepairEvent(root, state, 'repair-quarantined', { reason: state.stopReason });
      const receipt = await terminalReceipt(root, state, 'quarantined', state.stopReason);
      state.finalDisposition = { status: 'quarantined', receiptSha256: receipt.integrity.sha256 };
      await saveRepairState(root, state);
      throw new SingularityFlowError('Patch application failed after validation; the repair is quarantined.', { code: 'REPAIR_QUARANTINED' });
    }
    const candidateSnapshot = await repairWorktreeSnapshot(state.workspace.path, state.baseline);
    validatePatchScope(candidateSnapshot.changedPaths, plan);
    const unexplained = candidateSnapshot.changedPaths.filter((candidate) =>
      !touched.some((authorized) => pathInside(candidate, authorized) || pathInside(authorized, candidate)));
    if (unexplained.length) {
      state.status = 'quarantined';
      state.stopReason = 'patch-produced-unexplained-paths';
      await writeRepairEvent(root, state, 'repair-quarantined', { reason: state.stopReason, paths: unexplained });
      const receipt = await terminalReceipt(root, state, 'quarantined', state.stopReason);
      state.finalDisposition = { status: 'quarantined', receiptSha256: receipt.integrity.sha256 };
      await saveRepairState(root, state);
      throw new SingularityFlowError('Patch produced changes outside its declared diff paths; the repair is quarantined.', { code: 'REPAIR_QUARANTINED' });
    }
    state.status = 'verifying';
    await saveRepairState(root, state);
    const attemptNumber = state.attempts.length + 1;
    const patchDigest = sha256(patch);
    const storedPatch = statePath(root, 'repairs', id, 'patches', `${String(attemptNumber).padStart(3, '0')}-${patchDigest}.patch`);
    if (!await exists(storedPatch)) {
      await safeDirectory(path.dirname(storedPatch), stateRoot(root));
      await writeAtomic(storedPatch, patch, { mode: 0o600 });
    }
    // maxMinutes is a run budget, not a fresh allowance for every retry.
    const deadline = Date.parse(state.plan.createdAt) + state.plan.budgets.maxMinutes * 60_000;
    const verification = await runVerificationSet(root, state, patch, attemptNumber, deadline);
    const afterVerification = await repairWorktreeSnapshot(state.workspace.path, state.baseline);
    const candidateChanged = afterVerification.sha256 !== candidateSnapshot.sha256;
    const allPassed = !candidateChanged && verification.length === state.plan.verification.length
      && verification.every((entry) => entry.status === 'passed');
    const verifierUnavailable = verification.some((entry) => entry.status === 'unavailable' || entry.timedOut === true);
    const resultSignature = recordHash(verification.map((entry) => ({ id: entry.id, status: entry.status, exitCode: entry.exitCode, stderr: entry.stderr?.sha256 })));
    const previous = state.attempts.at(-1) ?? null;
    const twoBack = state.attempts.at(-2) ?? null;
    const noProgress = Boolean(previous && previous.patchSha256 === `sha256:${patchDigest}` && previous.resultSignature === resultSignature);
    const oscillating = Boolean(twoBack && twoBack.patchSha256 === `sha256:${patchDigest}` && previous?.patchSha256 !== `sha256:${patchDigest}`);
    const attemptCore = {
      schemaVersion: 1, recordType: 'repair-attempt', repairId: id, attempt: attemptNumber,
      at: nowIso(), patchSha256: `sha256:${patchDigest}`, patchPath: path.relative(stateRoot(root), storedPatch).replaceAll(path.sep, '/'),
      touchedPaths: touched,
      changedPaths: candidateSnapshot.changedPaths,
      diffSha256: candidateSnapshot.sha256,
      worktreeSha256: candidateSnapshot.sha256,
      verification, resultSignature, outcome: allPassed ? 'resolved'
        : candidateChanged ? 'quarantined-unexpected-mutation'
        : verifierUnavailable ? 'needs-human-verification-unavailable'
        : noProgress ? 'needs-human-no-progress'
          : oscillating ? 'needs-human-oscillation'
            : attemptNumber >= state.plan.budgets.maxAttempts ? 'exhausted' : 'retry-ready',
      model: null, adapter: null
    };
    const attempt = withIntegrity(attemptCore);
    await immutableWrite(root, statePath(root, 'repairs', id, 'attempts', `${String(attemptNumber).padStart(3, '0')}-${attempt.integrity.sha256}.json`), attempt, `Repair attempt ${attemptNumber}`);
    state.attempts = [...state.attempts, {
      attempt: attemptNumber, recordSha256: attempt.integrity.sha256, patchSha256: attempt.patchSha256,
      diffSha256: attempt.diffSha256, worktreeSha256: attempt.worktreeSha256,
      resultSignature, outcome: attempt.outcome
    }];
    state.status = allPassed ? 'resolved'
      : candidateChanged ? 'quarantined'
      : verifierUnavailable ? 'needs-human'
      : noProgress || oscillating ? 'needs-human'
        : attemptNumber >= state.plan.budgets.maxAttempts ? 'exhausted' : 'retry-ready';
    state.stopReason = allPassed ? 'verification-passed'
      : candidateChanged ? 'verification-mutated-repair-worktree'
      : verifierUnavailable ? 'verification-unavailable'
      : noProgress ? 'no-progress'
        : oscillating ? 'patch-oscillation'
          : state.status === 'exhausted' ? 'attempt-budget-exhausted' : 'verification-failed';
    await writeRepairEvent(root, state, 'repair-attempted', {
      attempt: attemptNumber, outcome: attempt.outcome, attemptSha256: attempt.integrity.sha256
    });
    let receipt = null;
    if (TERMINAL_REPAIR_STATES.has(state.status) || state.status === 'needs-human') {
      receipt = await terminalReceipt(root, state, state.status, state.stopReason);
      state.finalDisposition = { status: state.status, receiptSha256: receipt.integrity.sha256 };
    }
    state = await saveRepairState(root, state);
    return { repair: state, attempt, receipt };
  });
}

export async function cancelRepair(root, repairId, { reason } = {}) {
  const id = requireId(repairId, 'RPR', 'repairId');
  const explanation = requireText(reason, 'cancellation reason', { maximum: 4096 });
  return withSubjectLock(root, { kind: 'repair', id }, async () => {
    let state = await readRepair(root, id);
    if (TERMINAL_REPAIR_STATES.has(state.status)) throw new SingularityFlowError(`Repair '${id}' is already ${state.status}.`, { code: 'REPAIR_STATE_INVALID' });
    const actor = normalizedActor(root);
    state.status = 'cancelled';
    state.stopReason = 'human-cancelled';
    await writeRepairEvent(root, state, 'repair-cancelled', { reason: explanation, actor: actorKey(actor) });
    const receipt = await terminalReceipt(root, state, 'cancelled', explanation);
    state.finalDisposition = { status: 'cancelled', receiptSha256: receipt.integrity.sha256 };
    state = await saveRepairState(root, state);
    return { repair: state, receipt };
  });
}

export function repairNextActions(state) {
  if (state.status === 'awaiting-authorization') return [
    `singularity-flow repair authorize ${state.repairId} --confirm ${state.plan.integrity.sha256}`
  ];
  if (state.status === 'awaiting-patch') return [
    `singularity-flow repair attempt ${state.repairId} --patch <PATCH-FILE>`
  ];
  if (state.status === 'retry-ready') return [
    `singularity-flow repair authorize ${state.repairId} --confirm ${state.plan.integrity.sha256}`
  ];
  if (state.status === 'needs-human') return [
    `singularity-flow repair status ${state.repairId}`,
    `singularity-flow repair cancel ${state.repairId} --reason <REASON>`
  ];
  if (state.status === 'challenge-required' || state.status === 'challenge-opened') return [
    `singularity-flow fault show ${state.faultId}`,
    'singularity-flow explain reconciliation',
    'singularity-flow explain constitution'
  ];
  if (state.status === 'proposed' || state.status === 'diagnosis-ready' || state.status === 'recorded') return [
    `singularity-flow fault show ${state.faultId}`
  ];
  return [
    `singularity-flow repair status ${state.repairId}`,
    `singularity-flow fault show ${state.faultId}`
  ];
}

export async function wrapCommandWithFaultRepair(root, argv, {
  source = 'cli-run', environment = 'local', severity = 'medium', type = null,
  maxAttempts = null, allowedPaths = [], idempotencyKey = null, policy = {}, echo = true
} = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new SingularityFlowError("Use 'singularity-flow run --repair-on-fault -- <COMMAND> [ARGUMENTS...]'.", { code: 'FAULT_COMMAND_REQUIRED' });
  const result = run(argv[0], argv.slice(1), { cwd: root, allowFailure: true });
  if (echo && result.stdout) process.stdout.write(result.stdout);
  if (echo && result.stderr) process.stderr.write(result.stderr);
  const output = { stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr) };
  if (result.status === 0) return { command: argv, exitCode: 0, fault: null, repair: null, output };
  const inferred = type ?? (/test/i.test(argv.join(' ')) ? 'unit-test' : /lint/i.test(argv.join(' ')) ? 'lint' : /build|compile|tsc/i.test(argv.join(' ')) ? 'compile' : 'unknown');
  const reported = await reportFault(root, {
    source, environment, severity, idempotencyKey,
    correlationId: `run:${sha256(JSON.stringify(argv)).slice(0, 16)}:${head(root).slice(0, 12)}`,
    parentRepairId: process.env.SINGULARITY_FLOW_REPAIR_NO_RECURSION
      ? process.env.SINGULARITY_FLOW_REPAIR_ID ?? null
      : null,
    failure: {
      type: inferred, command: argv.join(' '), commandArgv: argv, exitCode: result.status,
      message: compact(result.stderr || result.stdout).slice(-4096) || `Command exited ${result.status}`
    },
    evidence: [
      ...(result.stdout ? [{ type: 'stdout', inline: String(result.stdout).slice(-8192), mediaType: 'text/plain' }] : []),
      ...(result.stderr ? [{ type: 'stderr', inline: String(result.stderr).slice(-8192), mediaType: 'text/plain' }] : [])
    ]
  }, { policy });
  let repair = null;
  if (!process.env.SINGULARITY_FLOW_REPAIR_NO_RECURSION) {
    repair = await requestRepair(root, reported.fault.faultId, {
      maxAttempts, allowedPaths, policy, executionEnvironment: 'local'
    });
  }
  return {
    command: argv, exitCode: result.status, fault: reported.fault, repair: repair?.repair ?? null,
    nested: Boolean(process.env.SINGULARITY_FLOW_REPAIR_NO_RECURSION), output
  };
}

/** Stable in-process API over exactly the same kernel functions the CLI calls. */
export function createFaultRepairApi(root, {
  policy = {}, policyResolver = governedFaultRepairPolicy, executionEnvironment = null
} = {}) {
  const resolvedPolicy = async ({ story = null, failClosed = false } = {}) => policyResolver(root, {
    story, restriction: policy, failClosed
  });
  return Object.freeze({
    fault: Object.freeze({
      report: async (envelope) => (await reportFault(root, envelope, {
        policy: await resolvedPolicy({ story: envelope?.story ?? null })
      })).fault,
      reportResult: async (envelope) => reportFault(root, envelope, {
        policy: await resolvedPolicy({ story: envelope?.story ?? null })
      }),
      get: (faultId) => readFault(root, faultId),
      list: (options) => listFaults(root, options),
      diagnose: (faultId, options) => diagnoseFault(root, faultId, options)
    }),
    repair: Object.freeze({
      request: async (request) => {
        const fault = await readFault(root, request.faultId);
        return requestRepair(root, request.faultId, {
          ...request,
          policy: await resolvedPolicy({ story: fault.story, failClosed: true }),
          executionEnvironment: executionEnvironment ?? fault.environment
        });
      },
      get: (repairId) => readRepair(root, repairId),
      list: (options) => listRepairs(root, options),
      authorize: (repairId, options) => authorizeRepair(root, repairId, options),
      attempt: (repairId, options) => attemptRepair(root, repairId, options),
      cancel: (repairId, options) => cancelRepair(root, repairId, options)
    })
  });
}
