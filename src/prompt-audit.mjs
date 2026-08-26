import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  appendFile, chmod, mkdir, open, readFile, readdir, realpath, rm, stat, unlink
} from 'node:fs/promises';
import { activeWorkspaceFile, workspaceContextForRepository, workspaceRegistryFile } from './workspace-context.mjs';
import { gitCommonDir, gitDir } from './git.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { canonicalJson } from './records.mjs';
import { readWorkspace, workspaceRepositoryPath } from './workspace.mjs';

export const PROMPT_AUDIT_SCHEMA_VERSION = currentSchemaVersion('prompt-audit-record');
const DIRECTORY = 'prompt-audit';
const SETTINGS = 'settings.json';
const LOG = 'prompts.jsonl';
const KEY = 'integrity.key';
const LOCK = 'write.lock';
const RECOVERY_DIRECTORY = 'recovery';
const DEFAULT_RETENTION_DAYS = 30;
const MAXIMUM_RETENTION_DAYS = 365;
const DEFAULT_MAXIMUM_BYTES = 64 * 1024 * 1024;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_RETRIES = 250;
const LOCK_RETRY_MS = 20;

// Prompt capture is deliberately narrower than diagnostic logging. It preserves the governed
// prompt a reviewer needs to audit, while removing common bearer-token shapes before bytes touch
// disk. The record says when this happened so it is never represented as a byte-exact transcript.
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  /\b(?:[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|PASSWORD|PASSWD|SECRET))\b["']?\s*[:=]\s*(["'])[^\r\n]*?\1/gi,
  /\b(?:[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|PASSWORD|PASSWD|SECRET))\b\s*[:=]\s*[^\s"',;]{4,}/gi,
  /--(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s+\S+/gi,
  /<(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)>[^<]+<\/(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)>/gi
];

export function scrubPrompt(value) {
  let prompt = String(value ?? '');
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    prompt = prompt.replace(pattern, () => { redactions += 1; return '[redacted-secret]'; });
  }
  return { prompt, redactions };
}

function retentionDays(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAXIMUM_RETENTION_DAYS
    ? value : DEFAULT_RETENTION_DAYS;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withAuditLock(directory, callback) {
  await ensurePrivateDirectory(directory);
  const file = path.join(directory, LOCK);
  const token = `${process.pid}:${randomUUID()}`;
  let handle = null;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const candidate = await open(file, 'wx', 0o600);
      try { await candidate.writeFile(token); }
      catch (error) {
        await candidate.close().catch(() => {});
        await unlink(file).catch(() => {});
        throw error;
      }
      handle = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(file).catch(() => {});
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  if (!handle) {
    throw new SingularityFlowError('Prompt-audit storage is busy. Retry the command.', {
      code: 'PROMPT_AUDIT_LOCK_BUSY'
    });
  }
  try { return await callback(); }
  finally {
    await handle.close().catch(() => {});
    const owner = await readFile(file, 'utf8').catch(() => null);
    if (owner === token) await unlink(file).catch(() => {});
  }
}

async function auditKey(directory, { create = false } = {}) {
  const file = path.join(directory, KEY);
  let key = await readFile(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!key && create) {
    await ensurePrivateDirectory(directory);
    const candidate = randomBytes(32);
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(candidate); } finally { await handle.close(); }
      key = candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      key = await readFile(file);
    }
  }
  if (key && key.length !== 32) {
    throw new SingularityFlowError('Prompt-audit integrity key is invalid.', {
      code: 'PROMPT_AUDIT_KEY_INVALID'
    });
  }
  return key;
}

function integrityPayload(record) {
  const copy = structuredClone(record);
  delete copy.integrity;
  return canonicalJson(copy);
}

function integrityMac(key, payload, previousMac) {
  return createHmac('sha256', key)
    .update(`${previousMac ?? 'chain-root'}\n${payload}`)
    .digest('hex');
}

function sealRecord(record, key, previousMac = null) {
  const payload = integrityPayload(record);
  return {
    ...record,
    integrity: {
      scheme: 'machine-local-hmac-chain-v1',
      keyId: `sha256:${createHash('sha256').update(key).digest('hex')}`,
      previousMac,
      payloadSha256: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
      mac: `sha256:${integrityMac(key, payload, previousMac)}`
    }
  };
}

function verifyRecordIntegrity(record, key, expectedPreviousMac, hasPriorSealed) {
  const integrity = record.integrity;
  if (!integrity) return { status: 'legacy-unsealed', findings: [] };
  const findings = [];
  if (integrity.scheme !== 'machine-local-hmac-chain-v1') findings.push('unsupported integrity scheme');
  if (!key) findings.push('machine-local integrity key is unavailable');
  const payload = integrityPayload(record);
  const payloadSha256 = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  if (integrity.payloadSha256 !== payloadSha256) findings.push('payload hash does not match');
  const prompt = String(record.prompt ?? '');
  if (record.bytes !== Buffer.byteLength(prompt)) findings.push('prompt byte count does not match');
  if (record.promptSha256 !== createHash('sha256').update(prompt).digest('hex')) findings.push('prompt hash does not match');
  if ((record.handoffSha256 == null) !== (record.handoffBytes == null)) findings.push('handoff identity is incomplete');
  if (record.handoffSha256 != null && !/^[a-f0-9]{64}$/.test(String(record.handoffSha256))) findings.push('handoff hash is invalid');
  if (record.handoffBytes != null
      && (!Number.isSafeInteger(record.handoffBytes) || record.handoffBytes < 0)) findings.push('handoff byte count is invalid');
  if (hasPriorSealed && integrity.previousMac !== expectedPreviousMac) findings.push('record chain is broken');
  if (key) {
    const keyId = `sha256:${createHash('sha256').update(key).digest('hex')}`;
    if (integrity.keyId !== keyId) findings.push('integrity key does not match');
    const expected = Buffer.from(integrityMac(key, payload, integrity.previousMac), 'hex');
    const actualHex = String(integrity.mac ?? '').replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(actualHex)
        || !timingSafeEqual(expected, Buffer.from(actualHex, 'hex'))) findings.push('record MAC does not match');
  }
  return { status: findings.length ? 'failed' : 'verified', findings };
}

async function location(root) {
  const workspace = await workspaceContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile(), { strict: true }
  );
  const directory = workspace
    ? path.join(workspace.workspacePath, '.singularity-flow', DIRECTORY)
    : path.join(gitDir(root), 'singularity-flow', DIRECTORY);
  return {
    scope: workspace ? 'workspace' : 'repository',
    workspaceId: workspace?.workspaceId ?? null,
    workspaceName: workspace?.workspaceName ?? null,
    workspacePath: workspace?.workspacePath ?? null,
    repositoryPath: path.resolve(root),
    directory,
    settingsFile: path.join(directory, SETTINGS),
    logFile: path.join(directory, LOG)
  };
}

async function settings(file) {
  try {
    const value = readRecord('prompt-audit-settings', await readFile(file)).record;
    return {
      enabled: value?.enabled === true,
      updatedAt: value?.updatedAt ?? null,
      retentionDays: retentionDays(value?.retentionDays),
      lastPrunedAt: value?.lastPrunedAt ?? null,
      headMac: value?.headMac ?? null,
      tailMac: value?.tailMac ?? null,
      logBytes: Number.isInteger(value?.logBytes) ? value.logBytes : null,
      logMtimeMs: Number.isFinite(value?.logMtimeMs) ? value.logMtimeMs : null,
      maximumBytes: Number.isSafeInteger(value?.maximumBytes) && value.maximumBytes >= 1024
        ? value.maximumBytes : DEFAULT_MAXIMUM_BYTES
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return {
      enabled: false, updatedAt: null, retentionDays: DEFAULT_RETENTION_DAYS, lastPrunedAt: null,
      headMac: null, tailMac: null, logBytes: null, logMtimeMs: null,
      maximumBytes: DEFAULT_MAXIMUM_BYTES
    };
    throw new SingularityFlowError(`Prompt-audit settings are invalid: ${error.message}`);
  }
}

async function entries(file, directory) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return {
      records: [], items: [], malformed: [], warnings: [],
      integrity: { status: 'empty', verified: 0, legacy: 0, failed: 0, malformed: 0 }
    };
    throw error;
  }
  const key = await auditKey(directory, { create: false }).catch(() => null);
  const records = [];
  const items = [];
  const malformed = [];
  const warnings = [];
  let previousMac = null;
  let hasPriorSealed = false;
  let verified = 0;
  let legacy = 0;
  let failed = 0;
  for (const [index, raw] of text.split('\n').entries()) {
    if (!raw.trim()) continue;
    try {
      const decoded = readRecord('prompt-audit-record', raw);
      const verification = verifyRecordIntegrity(decoded.record, key, previousMac, hasPriorSealed);
      if (verification.status === 'verified') verified += 1;
      else if (verification.status === 'legacy-unsealed') legacy += 1;
      else failed += 1;
      if (verification.findings.length) {
        warnings.push(`Prompt-audit record ${decoded.record.id ?? `line ${index + 1}`} failed integrity: ${verification.findings.join('; ')}.`);
      }
      records.push({ ...decoded.record, integrityVerification: verification });
      items.push({ raw, record: decoded.record, storedVersion: decoded.storedVersion, verification });
      if (decoded.record.integrity?.mac) {
        previousMac = decoded.record.integrity.mac;
        hasPriorSealed = true;
      }
    } catch (error) {
      malformed.push({ line: index + 1, raw, error: error.message });
      warnings.push(`Prompt-audit log contains malformed data on line ${index + 1}; valid records remain readable.`);
    }
  }
  const status = failed || malformed.length ? 'failed'
    : verified && legacy ? 'mixed'
      : verified ? 'verified'
        : legacy ? 'legacy-unsealed' : 'empty';
  return {
    records, items, malformed, warnings,
    integrity: { status, verified, legacy, failed, malformed: malformed.length }
  };
}

function applyIntegrityAnchors(data, config, { allowTailAdvance = false } = {}) {
  const sealed = data.items.filter((item) => item.record.integrity?.mac);
  const firstMac = sealed[0]?.record.integrity.mac ?? null;
  const lastMac = sealed.at(-1)?.record.integrity.mac ?? null;
  const findings = [];
  if (config.headMac && config.headMac !== firstMac) findings.push('the anchored first record is missing or changed');
  if (config.tailMac && config.tailMac !== lastMac
      && !(allowTailAdvance && sealed.some((item) => item.record.integrity.mac === config.tailMac))) {
    findings.push('the anchored last record is missing or changed');
  }
  if (!findings.length) return data;
  return {
    ...data,
    warnings: [...data.warnings, `Prompt-audit chain anchor failed: ${findings.join('; ')}.`],
    integrity: { ...data.integrity, status: 'failed', failed: data.integrity.failed + findings.length }
  };
}

async function allowedRepositoryRoots(root, target) {
  const roots = !target.workspacePath
    ? [await realpath(root).catch(() => path.resolve(root))]
    : await (async () => {
      const workspace = await readWorkspace(target.workspacePath);
      return Promise.all(Object.values(workspace.repositories)
        .map((repository) => {
          const candidate = workspaceRepositoryPath(workspace, repository);
          return realpath(candidate).catch(() => path.resolve(candidate));
        }));
    })();
  return {
    roots: new Set(roots),
    // A managed Story checkout has a different worktree Git directory but the same common Git
    // directory as its registered workspace repository. This is the bounded identity that admits
    // its invocation receipts without allowing an arbitrary path named in a prompt record.
    commonGitDirectories: new Set(roots.map((repository) => {
      try { return gitCommonDir(repository); }
      catch { return null; }
    }).filter(Boolean))
  };
}

function allowedRepository(repository, allowed) {
  if (allowed.roots.has(repository)) return true;
  try { return allowed.commonGitDirectories.has(gitCommonDir(repository)); }
  catch { return false; }
}

async function invocationEntries(root, promptRecords, target) {
  const allowed = await allowedRepositoryRoots(root, target);
  const requested = new Map();
  const fallbackRepositories = new Set();
  for (const record of promptRecords) {
    const repository = record._repositoryCanonical;
    if (!allowedRepository(repository, allowed)) continue;
    const linked = linkedInvocationId(record);
    if (linked && /^[A-Za-z0-9._-]{1,128}$/.test(linked)) {
      if (!requested.has(repository)) requested.set(repository, new Set());
      requested.get(repository).add(linked);
    } else if (record.source === 'model-invocation') fallbackRepositories.add(repository);
  }
  const records = [];
  for (const [repository, ids] of requested) {
    const directory = path.join(gitDir(repository), 'singularity-flow', 'model-invocations');
    for (const id of ids) {
      const text = await readFile(path.join(directory, `${id}.json`), 'utf8').catch(() => null);
      if (text === null) continue;
      try { records.push({ ...readRecord('model-invocation-audit', text).record, repositoryPath: repository }); }
      catch { /* One unreadable invocation must not hide otherwise valid prompt records. */ }
    }
  }
  for (const repository of fallbackRepositories) {
    const directory = path.join(gitDir(repository), 'singularity-flow', 'model-invocations');
    const names = await readdir(directory).catch(() => []);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const text = await readFile(path.join(directory, name), 'utf8').catch(() => null);
      if (text === null) continue;
      try { records.push({ ...readRecord('model-invocation-audit', text).record, repositoryPath: repository }); }
      catch { /* A legacy fallback remains best-effort. */ }
    }
  }
  return records;
}

function linkedInvocationId(record) {
  return (record.supportingEvidence ?? []).find((entry) => (
    entry?.kind === 'model-invocation-audit' && typeof entry.id === 'string'
  ))?.id ?? null;
}

function numericUsage(usage, field) {
  const raw = usage?.[field];
  const direct = raw == null ? Number.NaN : Number(raw);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const observedRaw = usage?.observations?.[field]?.value;
  const observed = observedRaw == null ? Number.NaN : Number(observedRaw);
  return Number.isFinite(observed) && observed >= 0 ? observed : null;
}

function executionProjection(record, invocation) {
  const estimationBytes = Number.isSafeInteger(invocation?.promptBytes)
    ? invocation.promptBytes : Number.isSafeInteger(record.handoffBytes) ? record.handoffBytes : record.bytes;
  const estimatedPromptTokens = Number.isSafeInteger(estimationBytes)
    ? Math.ceil(estimationBytes / 4) : null;
  if (!invocation) return {
    observation: 'not-observed',
    reason: record.source === 'vscode-governed-handoff'
      ? 'This governed prompt was handed to the Copilot host; the kernel did not observe the host invocation.'
      : 'Prompt composition does not prove that a model invocation occurred.',
    invocationId: null,
    operationId: null,
    provider: null,
    model: null,
    requestedModel: null,
    modelSelection: null,
    routing: null,
    channel: null,
    status: 'not-observed',
    startedAt: null,
    completedAt: null,
    durationMs: null,
    tools: {
      policyStatus: 'unavailable', mode: null, allowed: [],
      requireSuccessful: null, rejectTruncated: null,
      observedCalls: null, totalCalls: null, failedCalls: null, incompleteCalls: null,
      truncatedCalls: null, turns: null, turnAssurance: null,
      observation: 'Tool-call execution is not captured for this handoff.'
    },
    tokens: {
      status: 'unavailable', assurance: 'unavailable', input: null, output: null,
      cachedInput: null, reasoning: null, total: null, providerCost: null,
      promptEstimate: {
        value: estimatedPromptTokens, status: estimatedPromptTokens == null ? 'unavailable' : 'estimated',
        assurance: estimatedPromptTokens == null ? 'unavailable' : 'sflow-estimated',
        basis: estimatedPromptTokens == null ? null : 'UTF-8 bytes divided by four, rounded up'
      }
    },
    limits: null,
    prompt: null,
    output: null,
    error: null,
    tokenAdmission: null,
    economics: null
  };
  const input = numericUsage(invocation.usage, 'inputTokens');
  const output = numericUsage(invocation.usage, 'outputTokens');
  const cachedInput = numericUsage(invocation.usage, 'cachedInputTokens');
  const total = numericUsage(invocation.usage, 'totalTokens')
    ?? (input != null && output != null ? input + output : null);
  const completed = Date.parse(invocation.completedAt);
  const started = Date.parse(invocation.startedAt);
  return {
    observation: 'exact-invocation-audit',
    reason: null,
    invocationId: invocation.id,
    operationId: invocation.operationId ?? null,
    provider: invocation.provider ?? null,
    model: invocation.model ?? invocation.routing?.resolvedModel ?? null,
    requestedModel: invocation.requestedModel ?? invocation.modelSelection?.requestedModel ?? null,
    modelSelection: invocation.modelSelection ?? null,
    routing: invocation.routing ?? null,
    channel: invocation.channel ?? null,
    status: invocation.status,
    startedAt: invocation.startedAt ?? null,
    completedAt: invocation.completedAt ?? null,
    durationMs: Number.isFinite(started) && Number.isFinite(completed)
      ? Math.max(0, completed - started) : null,
    tools: {
      policyStatus: 'exact',
      mode: invocation.toolPolicy?.mode ?? null,
      allowed: [...(invocation.toolPolicy?.names ?? [])],
      requireSuccessful: invocation.toolPolicy?.requireSuccessful ?? null,
      rejectTruncated: invocation.toolPolicy?.rejectTruncated ?? null,
      observedCalls: invocation.toolObservation?.calls ?? null,
      totalCalls: invocation.toolObservation?.totalCalls ?? null,
      failedCalls: invocation.toolObservation?.failedCalls ?? null,
      incompleteCalls: invocation.toolObservation?.incompleteCalls ?? null,
      truncatedCalls: invocation.toolObservation?.truncatedCalls ?? null,
      turns: invocation.toolObservation?.turns ?? null,
      turnAssurance: invocation.toolObservation?.turnAssurance ?? null,
      observation: invocation.toolObservation
        ? 'ACP tool outcomes are recorded without arguments, paths, or result content.'
        : 'Tool-call execution is unavailable for this invocation.'
    },
    tokens: {
      status: invocation.usage?.status ?? (total == null ? 'unavailable' : 'exact'),
      assurance: invocation.usage?.assurance ?? (total == null ? 'unavailable' : 'provider-reported'),
      input,
      output,
      cachedInput,
      reasoning: numericUsage(invocation.usage, 'reasoningTokens'),
      total,
      providerCost: Number.isFinite(invocation.usage?.providerCost) ? invocation.usage.providerCost : null,
      promptEstimate: {
        value: estimatedPromptTokens, status: estimatedPromptTokens == null ? 'unavailable' : 'estimated',
        assurance: estimatedPromptTokens == null ? 'unavailable' : 'sflow-estimated',
        basis: estimatedPromptTokens == null ? null : 'UTF-8 bytes divided by four, rounded up'
      }
    },
    limits: invocation.limits ?? null,
    prompt: {
      bytes: invocation.promptBytes ?? null,
      sha256: invocation.promptSha256 ?? null,
      transport: invocation.promptTransport ?? null,
      protocolVersion: invocation.promptProtocolVersion ?? null,
      encoding: invocation.promptEncoding ?? null
    },
    output: invocation.outputBytes == null ? null : {
      bytes: invocation.outputBytes, sha256: invocation.outputSha256 ?? null
    },
    error: invocation.error ?? null,
    tokenAdmission: invocation.tokenAdmission ?? null,
    economics: invocation.economics ?? {
      provider: {
        inputTokens: input,
        outputTokens: output,
        cachedInputTokens: cachedInput,
        uncachedInputTokens: input != null && cachedInput != null && cachedInput <= input
          ? input - cachedInput : null,
        assurance: invocation.usage?.assurance ?? (input == null ? 'unavailable' : 'provider-reported')
      },
      system: { totalSystemTokens: null, assurance: 'unavailable' }
    }
  };
}

function matchingInvocation(record, invocations) {
  const linked = linkedInvocationId(record);
  const repository = record._repositoryCanonical;
  if (linked) return invocations.find((entry) => (
    entry.id === linked && entry.repositoryPath === repository
  )) ?? null;
  // Exact prompt bytes alone do not prove that a composition handoff became an invocation.
  // Hash fallback is reserved for invocation records written before the explicit evidence link.
  if (record.source !== 'model-invocation') return null;
  const matching = invocations.filter((entry) => (
    entry.promptSha256 === (record.handoffSha256 ?? record.promptSha256)
    && entry.repositoryPath === repository
  ));
  if (matching.length < 2) return matching[0] ?? null;
  const at = Date.parse(record.recordedAt);
  return matching.sort((left, right) => (
    Math.abs(Date.parse(left.completedAt ?? left.startedAt) - at)
    - Math.abs(Date.parse(right.completedAt ?? right.startedAt) - at)
  ))[0];
}

async function enrichRecords(root, records, target) {
  const scoped = await Promise.all(records.map(async (record) => ({
    ...record,
    _repositoryCanonical: await realpath(record.repositoryPath ?? root)
      .catch(() => path.resolve(record.repositoryPath ?? root))
  })));
  const invocations = await invocationEntries(root, scoped, target);
  return scoped.map((record) => {
    const { _repositoryCanonical: _ignored, ...publicRecord } = record;
    return {
      ...publicRecord,
      execution: executionProjection(publicRecord, matchingInvocation(record, invocations))
    };
  });
}

function display(value, fallback = 'unavailable') {
  return value == null || value === '' ? fallback : String(value);
}

function duration(value) {
  if (!Number.isFinite(value)) return 'unavailable';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
}

function token(value) { return Number.isFinite(value) ? value.toLocaleString('en-US') : 'unavailable'; }

/** Human-readable projection used by the CLI and relayed unchanged by /sf-prompt-log. */
export function renderPromptAudit(record) {
  const execution = record.execution ?? executionProjection(record, null);
  const tools = execution.tools;
  const tokens = execution.tokens;
  const allowed = tools.mode === 'none' ? 'None'
    : tools.allowed.length ? tools.allowed.map((name) => `\`${name}\``).join(', ')
      : tools.mode === 'all' ? 'All provider tools' : 'Unavailable';
  const evidence = record.supportingEvidence ?? [];
  const references = record.references ?? [];
  const duplicateReferenceBytes = (record.composition?.deduplicatedReferences ?? [])
    .reduce((total, entry) => total + (entry.previewBytes ?? 0), 0);
  const astSection = (record.composition?.sections ?? [])
    .find((section) => section.id === 'optional-ast-context');
  const lines = [
    `# Prompt audit ${record.id}`,
    '',
    '## Context',
    '',
    `- Recorded: ${record.recordedAt}`,
    `- Source: ${display(record.source)}`,
    `- Agent: ${display(record.agent)}`,
    `- Story: ${display(record.workId, 'none')}`,
    `- Work type: ${display(record.workType)}`,
    `- Phase: ${display(record.phase)}`,
    `- Generation: ${display(record.generation)}`,
    `- Task: ${display(record.task)}`,
    '',
    '## Model and execution',
    '',
    `- Observation: ${execution.observation}`,
    `- Status: ${execution.status}`,
    `- Provider: ${display(execution.provider)}`,
    `- Model: ${display(execution.model)}`,
    `- Requested model selector: ${display(execution.requestedModel)}`,
    `- Model-selection policy: ${display(execution.modelSelection?.policy)}`,
    `- Provider-selected model: ${display(execution.modelSelection?.providerSelectedModel)}`,
    `- Provider-reported resolved models: ${(execution.modelSelection?.resolvedModels ?? []).join(', ') || 'unavailable'}`,
    `- Model assurance: ${display(execution.modelSelection?.assurance)}`,
    `- Channel: ${display(execution.channel)}`,
    `- Operation: ${display(execution.operationId)}`,
    `- Invocation: ${display(execution.invocationId)}`,
    `- Started: ${display(execution.startedAt)}`,
    `- Completed: ${display(execution.completedAt)}`,
    `- Duration: ${duration(execution.durationMs)}`,
    `- Error code: ${display(execution.error?.code)}`,
    ...(execution.reason ? [`- Note: ${execution.reason}`] : []),
    '',
    '## Tools',
    '',
    `- Authorization evidence: ${tools.policyStatus}`,
    `- Policy: ${display(tools.mode)}`,
    `- Allowed tools: ${allowed}`,
    `- Require successful calls: ${display(tools.requireSuccessful)}`,
    `- Reject truncated results: ${display(tools.rejectTruncated)}`,
    `- Observed tool calls: ${tools.totalCalls == null ? 'unavailable' : tools.totalCalls.toLocaleString('en-US')}`,
    `- Failed calls: ${tools.failedCalls == null ? 'unavailable' : tools.failedCalls.toLocaleString('en-US')}`,
    `- Incomplete calls: ${tools.incompleteCalls == null ? 'unavailable' : tools.incompleteCalls.toLocaleString('en-US')}`,
    `- Truncated calls: ${tools.truncatedCalls == null ? 'unavailable' : tools.truncatedCalls.toLocaleString('en-US')}`,
    `- Model turns: ${tools.turns == null ? 'unavailable' : `${tools.turns.toLocaleString('en-US')} (${tools.turnAssurance})`}`,
    ...((tools.observedCalls ?? []).map((call) => (
      `- Call ${call.sequence}: ${call.name} · ${call.kind} · ${call.status} · ${call.outputBytes.toLocaleString('en-US')} bytes${call.truncated ? ' · truncated' : ''}${call.preparationFailed ? ' · preparation failed' : ''}`
    ))),
    `- Note: ${tools.observation}`,
    '',
    '## Tokens and cost',
    '',
    `- Provider usage status: ${tokens.status} (${tokens.assurance})`,
    `- Input tokens: ${token(tokens.input)}`,
    `- Output tokens: ${token(tokens.output)}`,
    `- Cached input tokens: ${token(tokens.cachedInput)}`,
    `- Reasoning tokens: ${token(tokens.reasoning)}`,
    `- Total provider tokens: ${token(tokens.total)}`,
    `- Provider cost: ${Number.isFinite(tokens.providerCost) ? `$${tokens.providerCost.toFixed(6)}` : 'unavailable'}`,
    `- Prompt-only estimate: ${token(tokens.promptEstimate.value)} (${tokens.promptEstimate.assurance})`,
    ...(tokens.promptEstimate.basis ? [`- Estimate basis: ${tokens.promptEstimate.basis}`] : []),
    '',
    '## Request and output',
    '',
    `- Captured prompt bytes: ${record.bytes.toLocaleString('en-US')}`,
    `- Captured prompt SHA-256: ${record.promptSha256}`,
    `- Exact handoff bytes: ${record.handoffBytes == null ? 'unavailable' : record.handoffBytes.toLocaleString('en-US')}`,
    `- Exact handoff SHA-256: ${display(record.handoffSha256)}`,
    `- Secret redactions: ${record.redactions}`,
    `- Record integrity: ${record.integrityVerification?.status ?? (record.integrity ? 'unverified' : 'legacy-unsealed')}`,
    `- Sent prompt bytes: ${execution.prompt?.bytes == null ? 'unavailable' : execution.prompt.bytes.toLocaleString('en-US')}`,
    `- Sent prompt SHA-256: ${display(execution.prompt?.sha256)}`,
    `- Prompt transport: ${display(execution.prompt?.transport)}`,
    `- Prompt protocol version: ${display(execution.prompt?.protocolVersion)}`,
    `- Prompt encoding: ${display(execution.prompt?.encoding)}`,
    `- Timeout limit: ${execution.limits?.timeoutMs == null ? 'unavailable' : duration(execution.limits.timeoutMs)}`,
    `- Output limit: ${execution.limits?.outputBytes == null ? 'unavailable' : `${execution.limits.outputBytes.toLocaleString('en-US')} bytes`}`,
    `- Total-token limit: ${execution.limits?.maxTotalTokens == null ? 'unavailable' : execution.limits.maxTotalTokens === 'auto' ? 'automatic (provider completion)' : execution.limits.maxTotalTokens.toLocaleString('en-US')}`,
    `- Model-turn limit: ${execution.limits?.maxTurns == null ? 'unavailable' : execution.limits.maxTurns === 'auto' ? 'automatic (provider completion)' : execution.limits.maxTurns.toLocaleString('en-US')}`,
    `- Tool-call limit: ${execution.limits?.maxToolCalls == null ? 'unavailable' : execution.limits.maxToolCalls === 'auto' ? 'automatic (provider completion)' : execution.limits.maxToolCalls.toLocaleString('en-US')}`,
    `- Tool-result limit: ${execution.limits?.maxToolResultBytes == null ? 'unavailable' : `${execution.limits.maxToolResultBytes.toLocaleString('en-US')} bytes`}`,
    `- Copilot premium-request limit: ${execution.limits?.maxAiCredits == null ? 'unavailable' : execution.limits.maxAiCredits === 'auto' ? 'automatic (provider/account policy)' : execution.limits.maxAiCredits.toLocaleString('en-US')}`,
    `- Output bytes: ${execution.output?.bytes == null ? 'unavailable' : execution.output.bytes.toLocaleString('en-US')}`,
    `- Output SHA-256: ${display(execution.output?.sha256)}`,
    '',
    '## Grounding and references',
    '',
    `- Supporting evidence records: ${evidence.length}`,
    `- Governed references: ${references.length}`,
    `- Composition cache: ${record.compositionCache ? `${record.compositionCache.hit ? 'hit' : 'miss'} (${record.compositionCache.key})` : 'unavailable'}`,
    `- Approved-input/reference duplicates removed: ${record.composition?.deduplicatedReferences?.length ?? 0}`,
    '',
    '## Prompt composition',
    '',
    `- Policy: ${record.composition?.policy ? `${record.composition.policy.mode}/${record.composition.policy.profile}` : 'unavailable'}`,
    `- Configured estimated prompt-text limit: ${record.composition?.policy?.maximumEstimatedPromptTokens == null ? 'unavailable' : `${record.composition.policy.maximumEstimatedPromptTokens.toLocaleString('en-US')} estimated tokens`}`,
    `- Before budgeting: ${record.composition?.originalBytes == null ? 'unavailable' : `${record.composition.originalBytes.toLocaleString('en-US')} bytes`}`,
    `- Sent after budgeting: ${record.composition?.finalBytes == null ? record.bytes.toLocaleString('en-US') : `${record.composition.finalBytes.toLocaleString('en-US')} bytes`}`,
    `- Optional sections omitted: ${record.composition?.omitted?.length ?? 0}`,
    ...((record.composition?.sections ?? []).map((section) =>
      `- ${section.included ? 'included' : 'omitted'} \`${section.id}\`: ${section.bytes.toLocaleString('en-US')} bytes · ${section.estimatedTokens.toLocaleString('en-US')} estimated tokens${section.mandatory ? ' · mandatory' : ''}`
    )),
    '',
    '## Context efficiency',
    '',
    `- Source bytes: ${record.composition?.economics?.source?.sourceBytes == null ? 'unavailable' : record.composition.economics.source.sourceBytes.toLocaleString('en-US')}`,
    `- Managed source bytes excluded before prompt composition: ${(record.composition?.economics?.source?.managedSourceBytesExcluded ?? record.composition?.inputLinearization?.managedBytesExcluded ?? 0).toLocaleString('en-US')} (source linearization; not a token-savings claim)`,
    `- Managed governed-reference bytes excluded before prompt composition: ${(record.composition?.economics?.source?.managedReferenceBytesExcluded ?? 0).toLocaleString('en-US')} (reference projection; not a token-savings claim)`,
    `- Duplicate approved-reference preview bytes excluded from prompt: ${(record.composition?.economics?.prompt?.deduplicatedPromptBytes ?? duplicateReferenceBytes).toLocaleString('en-US')}`,
    `- Budget-evicted prompt bytes: ${(record.composition?.economics?.prompt?.budgetEvictedPromptBytes ?? 0).toLocaleString('en-US')}`,
    `- Final prompt bytes: ${(record.composition?.economics?.prompt?.finalPromptBytes ?? record.bytes).toLocaleString('en-US')}`,
    `- Provider input tokens: ${token(execution.economics?.provider?.inputTokens)} (${execution.economics?.provider?.assurance ?? 'unavailable'})`,
    `- Provider cached input tokens: ${token(execution.economics?.provider?.cachedInputTokens)}`,
    `- Provider uncached input tokens: ${token(execution.economics?.provider?.uncachedInputTokens)}`,
    `- Provider/system tokens: ${token(execution.economics?.system?.totalSystemTokens)} (${execution.economics?.system?.assurance ?? 'unavailable'})`,
    `- Admission assurance: ${execution.tokenAdmission?.totalAdmissionTokens?.assurance ?? 'unavailable'}`,
    `- AST status: ${display(record.composition?.structuralContext?.status, 'not requested or unavailable')}`,
    `- AST facts selected: ${record.composition?.structuralContext?.factsReturned ?? 0}`,
    `- AST structural facts selected: ${record.composition?.structuralContext?.structuralFactsReturned ?? 0}`,
    `- AST prompt bytes: ${astSection?.included ? astSection.bytes.toLocaleString('en-US') : '0'}`,
    '',
    '## Prompt',
    '',
    '--- BEGIN CAPTURED GOVERNED PROMPT ---',
    record.prompt,
    '--- END CAPTURED GOVERNED PROMPT ---',
    ''
  ];
  return lines.join('\n');
}

async function recoveryCount(directory) {
  const names = await readdir(path.join(directory, RECOVERY_DIRECTORY)).catch((error) => (
    error?.code === 'ENOENT' ? [] : Promise.reject(error)
  ));
  return names.filter((name) => name.endsWith('.jsonl')).length;
}

async function statusSnapshot(root, target = null, config = null, data = null) {
  const resolvedTarget = target ?? await location(root);
  const resolvedConfig = config ?? await settings(resolvedTarget.settingsFile);
  const rawData = data ?? await entries(resolvedTarget.logFile, resolvedTarget.directory);
  const resolvedData = applyIntegrityAnchors(rawData, resolvedConfig);
  return {
    schemaVersion: PROMPT_AUDIT_SCHEMA_VERSION,
    enabled: resolvedConfig.enabled,
    updatedAt: resolvedConfig.updatedAt,
    retentionDays: resolvedConfig.retentionDays,
    maximumBytes: resolvedConfig.maximumBytes,
    lastPrunedAt: resolvedConfig.lastPrunedAt,
    count: resolvedData.records.length,
    latestAt: resolvedData.records.at(-1)?.recordedAt ?? null,
    integrity: resolvedData.integrity,
    warnings: resolvedData.warnings,
    recoveryFiles: await recoveryCount(resolvedTarget.directory),
    ...resolvedTarget
  };
}

async function writeSettings(target, config) {
  const value = {
    schemaVersion: currentSchemaVersion('prompt-audit-settings'),
    enabled: config.enabled === true,
    updatedAt: config.updatedAt ?? new Date().toISOString(),
    retentionDays: retentionDays(config.retentionDays),
    lastPrunedAt: config.lastPrunedAt ?? null,
    headMac: config.headMac ?? null,
    tailMac: config.tailMac ?? null,
    logBytes: Number.isInteger(config.logBytes) ? config.logBytes : null,
    logMtimeMs: Number.isFinite(config.logMtimeMs) ? config.logMtimeMs : null,
    maximumBytes: Number.isSafeInteger(config.maximumBytes) && config.maximumBytes >= 1024
      ? config.maximumBytes : DEFAULT_MAXIMUM_BYTES
  };
  await writeAtomic(target.settingsFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(target.settingsFile, 0o600).catch(() => {});
  return value;
}

async function rewriteLog(file, items) {
  const text = items.length ? `${items.map((item) => item.raw).join('\n')}\n` : '';
  await writeAtomic(file, text, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

async function recoverMalformedLog(target, data) {
  if (!data.malformed.length) return null;
  const recoveryDirectory = path.join(target.directory, RECOVERY_DIRECTORY);
  await ensurePrivateDirectory(recoveryDirectory);
  const now = new Date().toISOString();
  const recoveryFile = path.join(
    recoveryDirectory, `prompts-${now.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}.jsonl`
  );
  const original = await readFile(target.logFile, 'utf8');
  await writeAtomic(recoveryFile, original, { mode: 0o600 });
  await chmod(recoveryFile, 0o600).catch(() => {});
  await rewriteLog(target.logFile, data.items);
  return { file: recoveryFile, malformed: data.malformed.length };
}

async function maintainLog(target, config, { force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force && String(config.lastPrunedAt ?? '').slice(0, 10) === today) {
    return { config, recovery: null, removed: 0, data: null };
  }
  let data = await entries(target.logFile, target.directory);
  const recovery = await recoverMalformedLog(target, data);
  if (recovery) data = await entries(target.logFile, target.directory);
  const anchored = applyIntegrityAnchors(data, config, { allowTailAdvance: force });
  if (anchored.integrity.status === 'failed') {
    return { config, recovery, removed: 0, data: anchored };
  }
  const cutoff = Date.now() - (retentionDays(config.retentionDays) * 24 * 60 * 60 * 1000);
  let retained = data.items.filter((item) => {
    const recorded = Date.parse(item.record.recordedAt);
    return !Number.isFinite(recorded) || recorded >= cutoff;
  });
  let retainedBytes = retained.reduce((total, item) => total + Buffer.byteLength(item.raw) + 1, 0);
  let first = 0;
  while (retainedBytes > config.maximumBytes && retained.length - first > 1) {
    retainedBytes -= Buffer.byteLength(retained[first].raw) + 1;
    first += 1;
  }
  if (first) retained = retained.slice(first);
  const removed = data.items.length - retained.length;
  if (removed) await rewriteLog(target.logFile, retained);
  const sealed = retained.filter((item) => item.record.integrity?.mac);
  const logInfo = await stat(target.logFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  const next = await writeSettings(target, {
    ...config,
    lastPrunedAt: new Date().toISOString(),
    headMac: sealed[0]?.record.integrity.mac ?? null,
    tailMac: sealed.at(-1)?.record.integrity.mac ?? null,
    logBytes: logInfo?.size ?? 0,
    logMtimeMs: logInfo?.mtimeMs ?? null
  });
  return { config: next, recovery, removed, data };
}

async function lastLogRecord(file) {
  const info = await stat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.size) return null;
  const handle = await open(file, 'r');
  try {
    let position = info.size;
    const chunks = [];
    let foundContent = false;
    let foundBoundary = false;
    while (position > 0) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        const byte = chunk[index];
        if (!foundContent) {
          if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
          foundContent = true;
        } else if (byte === 0x0a) {
          foundBoundary = true;
          break;
        }
      }
      if (foundBoundary || position === 0) {
        const withoutTrailing = Buffer.concat(chunks).toString('utf8').replace(/\s+$/, '');
        const boundary = withoutTrailing.lastIndexOf('\n');
        const raw = withoutTrailing.slice(boundary + 1);
        if (!raw) return null;
        try { return readRecord('prompt-audit-record', raw).record; }
        catch { return { malformed: true }; }
      }
    }
    return null;
  } finally { await handle.close(); }
}

export async function promptAuditStatus(root) {
  return statusSnapshot(root);
}

export async function setPromptAudit(root, enabled) {
  const target = await location(root);
  await withAuditLock(target.directory, async () => {
    const current = await settings(target.settingsFile);
    await writeSettings(target, {
      ...current, enabled: Boolean(enabled), updatedAt: new Date().toISOString()
    });
  });
  return promptAuditStatus(root);
}

export async function setPromptAuditRetention(root, days) {
  if (!Number.isInteger(days) || days < 1 || days > MAXIMUM_RETENTION_DAYS) {
    throw new SingularityFlowError(`Prompt-audit retention must be an integer from 1 through ${MAXIMUM_RETENTION_DAYS}.`, {
      code: 'PROMPT_AUDIT_RETENTION_INVALID'
    });
  }
  const target = await location(root);
  await withAuditLock(target.directory, async () => {
    const current = await settings(target.settingsFile);
    const next = await writeSettings(target, {
      ...current, retentionDays: days, lastPrunedAt: null, updatedAt: new Date().toISOString()
    });
    await maintainLog(target, next, { force: true });
  });
  return promptAuditStatus(root);
}

export async function clearPromptAudits(root) {
  const target = await location(root);
  let removed = 0;
  await withAuditLock(target.directory, async () => {
    const data = await entries(target.logFile, target.directory);
    removed = data.records.length + data.malformed.length;
    await rm(target.logFile, { force: true });
    await rm(path.join(target.directory, RECOVERY_DIRECTORY), { recursive: true, force: true });
    const current = await settings(target.settingsFile);
    await writeSettings(target, {
      ...current, headMac: null, tailMac: null, logBytes: 0, logMtimeMs: null,
      lastPrunedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  });
  return { ...(await promptAuditStatus(root)), removed };
}

export async function repairPromptAudits(root) {
  const target = await location(root);
  let repaired = 0;
  let recoveryFile = null;
  let resealed = 0;
  await withAuditLock(target.directory, async () => {
    const data = await entries(target.logFile, target.directory);
    const current = await settings(target.settingsFile);
    const anchored = applyIntegrityAnchors(data, current);
    const requiresRepair = anchored.integrity.status === 'failed'
      || data.items.some((item) => item.verification.status !== 'verified');
    if (!requiresRepair) return;
    const recoveryDirectory = path.join(target.directory, RECOVERY_DIRECTORY);
    await ensurePrivateDirectory(recoveryDirectory);
    const now = new Date().toISOString();
    recoveryFile = path.join(
      recoveryDirectory, `prompts-repair-${now.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}.jsonl`
    );
    const original = await readFile(target.logFile, 'utf8').catch((error) => (
      error?.code === 'ENOENT' ? null : Promise.reject(error)
    ));
    if (original !== null) {
      await writeAtomic(recoveryFile, original, { mode: 0o600 });
      await chmod(recoveryFile, 0o600).catch(() => {});
    } else recoveryFile = null;
    let key;
    try { key = await auditKey(target.directory, { create: true }); }
    catch (error) {
      if (error?.code !== 'PROMPT_AUDIT_KEY_INVALID') throw error;
      await rm(path.join(target.directory, KEY), { force: true });
      key = await auditKey(target.directory, { create: true });
    }
    let previousMac = null;
    const next = [];
    for (const item of data.items) {
      const findings = item.verification.findings ?? [];
      const unsafe = findings.some((finding) => ![
        'machine-local integrity key is unavailable', 'integrity key does not match',
        'record chain is broken', 'record MAC does not match'
      ].includes(finding));
      if (unsafe) { repaired += 1; continue; }
      const keyUnavailable = findings.includes('machine-local integrity key is unavailable')
        || findings.includes('integrity key does not match');
      if (findings.includes('record MAC does not match') && !keyUnavailable) {
        repaired += 1;
        continue;
      }
      const core = structuredClone(item.record);
      delete core.integrity;
      core.schemaVersion = PROMPT_AUDIT_SCHEMA_VERSION;
      const sealed = sealRecord(core, key, previousMac);
      previousMac = sealed.integrity.mac;
      next.push({ raw: JSON.stringify(sealed) });
      resealed += 1;
    }
    repaired += data.malformed.length;
    await rewriteLog(target.logFile, next);
    const logInfo = await stat(target.logFile);
    await writeSettings(target, {
      ...current,
      headMac: next[0] ? JSON.parse(next[0].raw).integrity.mac : null,
      tailMac: next.at(-1) ? JSON.parse(next.at(-1).raw).integrity.mac : null,
      logBytes: logInfo.size,
      logMtimeMs: logInfo.mtimeMs,
      lastPrunedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  });
  return { ...(await promptAuditStatus(root)), repaired, resealed, recoveryFile };
}

export async function recordPromptAudit(root, input) {
  const target = await location(root);
  return withAuditLock(target.directory, async () => {
    let config = await settings(target.settingsFile);
    if (!config.enabled) return null;
    const before = await stat(target.logFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    const storageChanged = config.logBytes == null
      || config.logBytes !== (before?.size ?? 0)
      || (config.logMtimeMs != null && config.logMtimeMs !== (before?.mtimeMs ?? null));
    const maintenance = await maintainLog(target, config, { force: storageChanged });
    config = maintenance.config;
    if (maintenance.data?.integrity.status === 'failed') {
      throw new SingularityFlowError(
        `Prompt-audit history failed integrity: ${maintenance.data.warnings.join(' ')} Run singularity-flow prompt-log repair before retrying.`,
        { code: 'PROMPT_AUDIT_INTEGRITY_FAILED', details: { integrity: maintenance.data.integrity } }
      );
    }
    let previous = await lastLogRecord(target.logFile);
    if (previous?.malformed) {
      await maintainLog(target, config, { force: true });
      previous = await lastLogRecord(target.logFile);
    }
    const key = await auditKey(target.directory, { create: true });
    if (previous?.integrity) {
      const verification = verifyRecordIntegrity(previous, key, null, false);
      if (verification.status !== 'verified') {
        throw new SingularityFlowError(
          `Prompt-audit tail failed integrity: ${verification.findings.join('; ')}. Run singularity-flow prompt-log repair before retrying.`,
          { code: 'PROMPT_AUDIT_INTEGRITY_FAILED', details: { findings: verification.findings } }
        );
      }
      if (config.tailMac && previous.integrity.mac !== config.tailMac) {
        throw new SingularityFlowError(
          'Prompt-audit tail does not match its durable chain anchor. Run singularity-flow prompt-log repair before retrying.',
          { code: 'PROMPT_AUDIT_INTEGRITY_FAILED' }
        );
      }
    }
    const handoff = String(input.prompt ?? '');
    const scrubbed = scrubPrompt(handoff);
    const recordedAt = new Date().toISOString();
    const promptSha256 = createHash('sha256').update(scrubbed.prompt).digest('hex');
    const record = sealRecord({
      schemaVersion: PROMPT_AUDIT_SCHEMA_VERSION,
      id: `${recordedAt.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`,
      recordedAt,
      workspaceId: target.workspaceId,
      workspaceName: target.workspaceName,
      repositoryPath: target.repositoryPath,
      workId: input.workId ?? null,
      workType: input.workType ?? null,
      phase: input.phase,
      generation: input.generation ?? null,
      agent: input.agent,
      task: input.task ?? null,
      source: input.source ?? 'wm-compose',
      supportingEvidence: input.supportingEvidence ?? [],
      references: input.references ?? [],
      compositionCache: input.compositionCache ?? null,
      composition: input.composition ?? null,
      handoffSha256: createHash('sha256').update(handoff).digest('hex'),
      handoffBytes: Buffer.byteLength(handoff),
      promptSha256,
      bytes: Buffer.byteLength(scrubbed.prompt),
      redactions: scrubbed.redactions,
      prompt: scrubbed.prompt
    }, key, previous?.integrity?.mac ?? null);
    await appendFile(target.logFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await chmod(target.logFile, 0o600).catch(() => {});
    const after = await stat(target.logFile);
    const storedConfig = await writeSettings(target, {
      ...config,
      headMac: config.headMac ?? record.integrity.mac,
      tailMac: record.integrity.mac,
      logBytes: after.size,
      logMtimeMs: after.mtimeMs
    });
    if (after.size > storedConfig.maximumBytes) {
      await maintainLog(target, storedConfig, { force: true });
    }
    return { ...record, integrityVerification: { status: 'verified', findings: [] } };
  });
}

export async function listPromptAudits(root, filters = {}) {
  const target = await location(root);
  const config = await settings(target.settingsFile);
  const data = await entries(target.logFile, target.directory);
  const status = await statusSnapshot(root, target, config, data);
  const limit = Math.max(1, Math.min(Number(filters.limit ?? 100), 1000));
  let records = data.records;
  for (const key of ['agent', 'phase', 'workId']) {
    if (filters[key]) records = records.filter((record) => record[key] === filters[key]);
  }
  records = await enrichRecords(root, records.slice(-limit).reverse(), target);
  if (!filters.includePrompt) records = records.map(({ prompt: _prompt, ...record }) => record);
  return { ...status, records };
}

export async function readPromptAudit(root, id = 'latest') {
  const target = await location(root);
  const config = await settings(target.settingsFile);
  const data = await entries(target.logFile, target.directory);
  const status = await statusSnapshot(root, target, config, data);
  const record = id === 'latest' ? data.records.at(-1) : data.records.find((entry) => entry.id === id);
  if (!record) throw new SingularityFlowError(id === 'latest' ? 'No governed prompts have been captured.' : `Prompt-audit record '${id}' was not found.`);
  return { status, record: (await enrichRecords(root, [record], target))[0] };
}
