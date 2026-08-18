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
import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { gitDir, head, identity } from './git.mjs';
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
  'planned', 'proposed', 'awaiting-authorization', 'authorizing', 'awaiting-patch', 'repairing',
  'verifying', 'retry-ready', 'needs-human'
]);
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
const SECRET_RULES = Object.freeze([
  ['authorization', /\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1[REDACTED]'],
  ['assignment', /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]'],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]'],
  ['openai-token', /\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_TOKEN]'],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  ['url-credentials', /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@']
]);

export function sanitizeFaultText(value) {
  let text = String(value ?? '');
  const redactions = [];
  for (const [rule, expression, replacement] of SECRET_RULES) {
    let count = 0;
    text = text.replace(expression, (...args) => {
      count += 1;
      return typeof replacement === 'function' ? replacement(...args) : args[0].replace(expression, replacement);
    });
    if (count) redactions.push({ rule, count });
  }
  return { text, redactions };
}

function sanitizeValue(value, redactions, pathLabel = 'value') {
  if (typeof value === 'string') {
    const result = sanitizeFaultText(value);
    redactions.push(...result.redactions.map((entry) => ({ ...entry, field: pathLabel })));
    return result.text;
  }
  if (Array.isArray(value)) return value.map((entry, index) => sanitizeValue(entry, redactions, `${pathLabel}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, redactions, `${pathLabel}.${key}`)]));
  }
  return value;
}

export function normalizeFaultRepairPolicy(value = {}) {
  if (value == null) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('faultRepair must be an object.');
  const allowed = new Set([
    'enabled', 'maxAttempts', 'maxMinutes', 'maxTokens', 'maximumInlineEvidenceBytes',
    'maximumEvidenceBytes', 'leaseMinutes', 'boundedAuto', 'environmentCeilings', 'protectedPaths'
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`faultRepair contains unknown field '${key}'.`);
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

function stateRoot(root) {
  return path.join(gitDir(root), 'singularity-flow', 'fault-repair');
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
  if (!input || path.posix.isAbsolute(input) || input.split('/').includes('..') || input.includes('\0')) {
    throw new SingularityFlowError(`${label} must be a repository-relative path without '..'.`, { code: 'REPAIR_SCOPE_INVALID' });
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
  if (exitCode != null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) {
    throw new SingularityFlowError('failure.exitCode must be an integer from 0 through 255.', { code: 'FAULT_FIELD_INVALID' });
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
  const evidence = await materializeEvidence(root, sanitized.evidence ?? [], policy, redactions);
  const currentHead = head(root);
  const build = sanitized.build == null ? { id: null, commit: currentHead } : {
    id: optionalText(sanitized.build.id, 'build.id', { maximum: 256 }),
    commit: optionalText(sanitized.build.commit, 'build.commit', { maximum: 64, pattern: /^[a-f0-9]{7,64}$/i }) ?? currentHead
  };
  const requestedAction = sanitized.requestedAction ?? 'policy-decides';
  if (!['policy-decides', ...ACTION_CEILINGS].includes(requestedAction)) throw new SingularityFlowError(`Unknown requested action '${requestedAction}'.`);
  const occurredAt = validDate(sanitized.occurredAt, 'occurredAt', nowIso());
  const input = {
    source,
    correlationId: optionalText(sanitized.correlationId, 'correlationId', { maximum: 512 }),
    occurredAt,
    environment,
    severity,
    story: optionalText(sanitized.story, 'story', { maximum: 96 }),
    capability: optionalText(sanitized.capability, 'capability', { maximum: 128 }),
    build,
    failure,
    evidence,
    requestedAction,
    parentRepairId: sanitized.parentRepairId ? requireId(sanitized.parentRepairId, 'RPR', 'parentRepairId') : null
  };
  return {
    input,
    actor: normalizedActor(root, actor),
    faultId: sanitized.faultId ? requireId(sanitized.faultId, 'FLT', 'faultId') : null,
    idempotencyKey: optionalText(sanitized.idempotencyKey, 'idempotencyKey', { maximum: 512 }),
    redactions,
    requestSha256: recordHash(envelopeRequestCore(input, evidence))
  };
}

async function readFaultFile(file) {
  return requireSchema(await readJson(file), FAULT_ENVELOPE_SCHEMA_VERSION, 'FaultEnvelope');
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
    const fault = withIntegrity({ ...core, signature, occurrenceGroup: groupId });
    await immutableWrite(root, statePath(root, 'faults', `${faultId}.json`), fault, `Fault '${faultId}'`);

    const groupPath = statePath(root, 'groups', `${signature.slice(7)}.json`);
    const existing = await exists(groupPath) ? await readJson(groupPath) : null;
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
      : latest && ACTIVE_REPAIR_STATES.has(latest.status) ? 'repair-active'
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
  const result = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, allowFailure: true, encoding: 'buffer' });
  if (result.status !== 0) return [];
  const entries = result.stdout.toString('utf8').split('\0').filter(Boolean);
  return entries.map((entry) => entry.slice(3).split(' -> ').at(-1)).filter(Boolean).map((entry) => entry.replaceAll('\\', '/'));
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

export function effectiveRepairPolicy(fault, configuredPolicy = {}, { mode = 'policy-decides', maxAttempts = null } = {}) {
  const policy = normalizeFaultRepairPolicy(configuredPolicy);
  let ceiling = policy.environmentCeilings[fault.environment] ?? 'record';
  if (fault.environment === 'production' || fault.failure.type === 'production') ceiling = 'diagnose';
  if (['security', 'requirement', 'policy', 'architecture'].includes(fault.failure.type)) ceiling = 'diagnose';
  if (!policy.boundedAuto && ceiling === 'bounded-auto') ceiling = 'guided';
  const requested = requestedCeiling(mode, fault);
  const effectiveIndex = Math.min(ACTION_CEILINGS.indexOf(ceiling), ACTION_CEILINGS.indexOf(requested));
  return Object.freeze({
    ceiling: ACTION_CEILINGS[Math.max(0, effectiveIndex)],
    requested,
    policyCeiling: ceiling,
    maxAttempts: Math.min(policy.maxAttempts, Math.max(1, Number(maxAttempts) || policy.maxAttempts)),
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
  let escaped = false;
  for (const character of text) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
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
  if (quote || escaped) throw new SingularityFlowError('Verification command has an unterminated quote or escape.', { code: 'REPAIR_VERIFICATION_INVALID' });
  if (current) argv.push(current);
  if (!argv.length) throw new SingularityFlowError('Verification command is empty.', { code: 'REPAIR_VERIFICATION_INVALID' });
  return argv;
}

function verificationPlan(fault, supplied = []) {
  const commands = supplied.length
    ? supplied.map((entry) => Array.isArray(entry) ? entry.map(String) : parseVerificationCommand(entry))
    : fault.failure.commandArgv ? [fault.failure.commandArgv.map(String)] : [];
  return commands.map((argv, index) => ({ id: `verify-${index + 1}`, argv, required: true }));
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
    requestedMode: effective.requested,
    tools: {
      commands: verification.map((entry) => entry.argv),
      network: 'not-granted-by-sflow',
      environmentNames: ['CI', 'NODE_ENV'],
      capabilities: ['read-scoped-context', 'apply-validated-patch', 'run-pinned-verification']
    },
    escalation: [
      'scope-expansion', 'protected-path', 'baseline-change', 'verification-unavailable',
      'no-progress', 'patch-oscillation', 'budget-exhausted', 'intent-conflict'
    ],
    policyHash: effective.policyHash,
    diagnosisSha256: diagnosis.integrity.sha256
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
  policy: configuredPolicy = {}, persist = true
} = {}) {
  const fault = await readFault(root, faultId);
  const diagnosis = await diagnoseFault(root, fault.faultId, { persist });
  const effective = effectiveRepairPolicy(fault, configuredPolicy, { mode, maxAttempts });
  const paths = [...new Set((allowedPaths.length ? allowedPaths : diagnosis.affectedPaths)
    .map((entry) => normalizePathPrefix(entry, 'allowed path')))].sort();
  const checks = verificationPlan(fault, verification);
  const adequate = paths.length > 0 && checks.length > 0 && diagnosis.disposition !== 'challenge-intent';

  return withSubjectLock(root, { kind: 'repair-signature', id: fault.signature }, async () => {
    if (persist) {
      const active = (await repairStates(root)).find((entry) => entry.signature === fault.signature
        && entry.baseline === fault.build.commit && ACTIVE_REPAIR_STATES.has(entry.status));
      if (active) return { repair: active, plan: active.plan, diagnosis, joined: true, persisted: true };
    }
    const repairId = persist ? nextId('RPR') : `RPR-PREVIEW-${fault.faultId.slice(4)}`;
    const plan = withIntegrity(publicPlanCore({ repairId, fault, diagnosis, effective, allowedPaths: paths, verification: checks }));
    const status = diagnosis.disposition === 'challenge-intent'
      ? 'challenge-opened'
      : planStatus(effective.ceiling, adequate);
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
    await immutableWrite(root, statePath(root, 'repairs', repairId, 'plan.json'), plan, `Repair plan '${repairId}'`);
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
    const expected = state.plan.integrity.sha256;
    if (confirmation !== expected && confirmation !== `sha256:${expected}`) {
      throw new SingularityFlowError(`Authorization must confirm the exact plan hash '${expected}'.`, { code: 'REPAIR_CONFIRMATION_MISMATCH' });
    }
    if (head(root) !== state.baseline) {
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
      return { repair: state, opened: false };
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

async function terminalReceipt(root, state, disposition, reason) {
  const fault = await readFault(root, state.faultId);
  const diagnosisPointer = await readJson(statePath(root, 'diagnoses', state.faultId, 'latest.json')).catch(() => null);
  const diagnosis = diagnosisPointer?.diagnosisSha256
    ? await readJson(statePath(root, 'diagnoses', state.faultId, `${diagnosisPointer.diagnosisSha256}.json`)).then((record) => verifyIntegrity(record, 'FaultDiagnosis'))
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
    planGenerations: [{ generation: 1, sha256: state.plan.integrity.sha256 }],
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
      touchedPaths: attempt.touchedPaths,
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
    humanDecisions: (await directoryRecords(statePath(root, 'repairs', state.repairId, 'events'), async (file) => readJson(file)))
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
    if (recordHash(withoutIntegrity(state.plan)) !== state.plan.integrity.sha256) {
      throw new SingularityFlowError(`Repair '${id}' plan changed after authorization.`, { code: 'REPAIR_PLAN_CHANGED' });
    }
    validatePatchScope(touched, state.plan);
    if (!state.workspace?.path || !await exists(state.workspace.path)) throw new SingularityFlowError(`Repair '${id}' isolated worktree is unavailable.`, { code: 'REPAIR_WORKTREE_UNAVAILABLE' });
    if (run('git', ['rev-parse', 'HEAD'], { cwd: state.workspace.path }).stdout.trim() !== state.baseline) {
      throw new SingularityFlowError(`Repair '${id}' baseline changed before patch application.`, { code: 'REPAIR_BASELINE_CHANGED' });
    }
    const existingDiff = run('git', ['diff', '--binary', state.baseline, '--'], { cwd: state.workspace.path });
    const untracked = statusPaths(state.workspace.path).filter((candidate) =>
      run('git', ['ls-files', '--error-unmatch', '--', candidate], { cwd: state.workspace.path, allowFailure: true }).status !== 0);
    if (!state.attempts.length && (existingDiff.stdout || untracked.length)) {
      throw new SingularityFlowError(`Repair '${id}' worktree changed outside the kernel attempt path.`, { code: 'REPAIR_UNEXPECTED_MUTATION' });
    }
    if (state.attempts.length) {
      const expectedDiff = state.attempts.at(-1)?.diffSha256;
      if (`sha256:${sha256(existingDiff.stdout)}` !== expectedDiff || untracked.length) {
        throw new SingularityFlowError(`Repair '${id}' worktree changed after its previous attempt.`, { code: 'REPAIR_UNEXPECTED_MUTATION' });
      }
      // This is the isolated repair worktree, and the exact previous diff is already immutable in
      // the attempt record. Starting the next candidate from the pinned baseline prevents patches
      // from accumulating authority across attempts.
      run('git', ['reset', '--hard', state.baseline], { cwd: state.workspace.path });
      run('git', ['clean', '-fd'], { cwd: state.workspace.path });
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
    state.status = 'verifying';
    await saveRepairState(root, state);
    const attemptNumber = state.attempts.length + 1;
    const patchDigest = sha256(patch);
    const storedPatch = statePath(root, 'repairs', id, 'patches', `${String(attemptNumber).padStart(3, '0')}-${patchDigest}.patch`);
    if (!await exists(storedPatch)) {
      await safeDirectory(path.dirname(storedPatch), stateRoot(root));
      await writeAtomic(storedPatch, patch, { mode: 0o600 });
    }
    const verification = [];
    // maxMinutes is a run budget, not a fresh allowance for every retry.
    const deadline = Date.parse(state.plan.createdAt) + state.plan.budgets.maxMinutes * 60_000;
    for (const command of state.plan.verification) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        verification.push({ id: command.id, argv: command.argv, status: 'unavailable', reason: 'time-budget-exhausted' });
        break;
      }
      const result = run(command.argv[0], command.argv.slice(1), {
        cwd: state.workspace.path,
        allowFailure: true,
        timeoutMs: remaining,
        env: {
          ...process.env,
          SINGULARITY_FLOW_REPAIR_ID: id,
          SINGULARITY_FLOW_REPAIR_NO_RECURSION: '1',
          SINGULARITY_FLOW_NO_NETWORK: '1'
        }
      });
      verification.push({
        id: command.id, argv: command.argv, status: result.status === 0 ? 'passed' : 'failed',
        exitCode: result.status, stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr),
        timedOut: result.timedOut === true
      });
    }
    const allPassed = verification.length === state.plan.verification.length
      && verification.every((entry) => entry.status === 'passed');
    const verifierUnavailable = verification.some((entry) => entry.status === 'unavailable' || entry.timedOut === true);
    const resultSignature = recordHash(verification.map((entry) => ({ id: entry.id, status: entry.status, exitCode: entry.exitCode, stderr: entry.stderr?.sha256 })));
    const previous = state.attempts.at(-1) ?? null;
    const twoBack = state.attempts.at(-2) ?? null;
    const noProgress = Boolean(previous && previous.patchSha256 === `sha256:${patchDigest}` && previous.resultSignature === resultSignature);
    const oscillating = Boolean(twoBack && twoBack.patchSha256 === `sha256:${patchDigest}` && previous?.patchSha256 !== `sha256:${patchDigest}`);
    const diff = run('git', ['diff', '--binary', state.baseline, '--'], { cwd: state.workspace.path });
    const attemptCore = {
      schemaVersion: 1, recordType: 'repair-attempt', repairId: id, attempt: attemptNumber,
      at: nowIso(), patchSha256: `sha256:${patchDigest}`, patchPath: path.relative(stateRoot(root), storedPatch).replaceAll(path.sep, '/'),
      touchedPaths: touched, diffSha256: `sha256:${sha256(diff.stdout)}`,
      verification, resultSignature, outcome: allPassed ? 'resolved'
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
      diffSha256: attempt.diffSha256, resultSignature, outcome: attempt.outcome
    }];
    state.status = allPassed ? 'resolved'
      : verifierUnavailable ? 'needs-human'
      : noProgress || oscillating ? 'needs-human'
        : attemptNumber >= state.plan.budgets.maxAttempts ? 'exhausted' : 'retry-ready';
    state.stopReason = allPassed ? 'verification-passed'
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
  if (state.status === 'challenge-opened') return [
    `singularity-flow fault show ${state.faultId}`,
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
    repair = await requestRepair(root, reported.fault.faultId, { maxAttempts, allowedPaths, policy });
  }
  return {
    command: argv, exitCode: result.status, fault: reported.fault, repair: repair?.repair ?? null,
    nested: Boolean(process.env.SINGULARITY_FLOW_REPAIR_NO_RECURSION), output
  };
}

/** Stable in-process API over exactly the same kernel functions the CLI calls. */
export function createFaultRepairApi(root, { policy = {} } = {}) {
  return Object.freeze({
    fault: Object.freeze({
      report: async (envelope) => (await reportFault(root, envelope, { policy })).fault,
      reportResult: (envelope) => reportFault(root, envelope, { policy }),
      get: (faultId) => readFault(root, faultId),
      list: (options) => listFaults(root, options),
      diagnose: (faultId, options) => diagnoseFault(root, faultId, options)
    }),
    repair: Object.freeze({
      request: (request) => requestRepair(root, request.faultId, { ...request, policy }),
      get: (repairId) => readRepair(root, repairId),
      list: (options) => listRepairs(root, options),
      authorize: (repairId, options) => authorizeRepair(root, repairId, options),
      attempt: (repairId, options) => attemptRepair(root, repairId, options),
      cancel: (repairId, options) => cancelRepair(root, repairId, options)
    })
  });
}
