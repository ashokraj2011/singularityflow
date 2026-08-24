import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { activeWorkspaceFile, workspaceContextForRepository, workspaceRegistryFile } from './workspace-context.mjs';
import { gitDir } from './git.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const PROMPT_AUDIT_SCHEMA_VERSION = currentSchemaVersion('prompt-audit-record');
const DIRECTORY = 'prompt-audit';
const SETTINGS = 'settings.json';
const LOG = 'prompts.jsonl';

// Prompt capture is deliberately narrower than diagnostic logging. It preserves the governed
// prompt a reviewer needs to audit, while removing common bearer-token shapes before bytes touch
// disk. The record says when this happened so it is never represented as a byte-exact transcript.
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
];

export function scrubPrompt(value) {
  let prompt = String(value ?? '');
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    prompt = prompt.replace(pattern, () => { redactions += 1; return '[redacted-secret]'; });
  }
  return { prompt, redactions };
}

async function location(root) {
  const workspace = await workspaceContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile()
  ).catch(() => null);
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
    return { enabled: value?.enabled === true, updatedAt: value?.updatedAt ?? null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { enabled: false, updatedAt: null };
    throw new SingularityFlowError(`Prompt-audit settings are invalid: ${error.message}`);
  }
}

async function entries(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter((line) => line.trim()).map((line, index) => {
    try { return readRecord('prompt-audit-record', line).record; }
    catch { throw new SingularityFlowError(`Prompt-audit log contains invalid JSON on line ${index + 1}.`); }
  });
}

async function invocationEntries(root) {
  const directory = path.join(gitDir(root), 'singularity-flow', 'model-invocations');
  const names = await readdir(directory).catch(() => []);
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const text = await readFile(path.join(directory, name), 'utf8').catch(() => null);
    if (text === null) continue;
    try { records.push(readRecord('model-invocation-audit', text).record); }
    catch { /* One unreadable invocation must not hide otherwise valid prompt records. */ }
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
    ? invocation.promptBytes : record.bytes;
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
    channel: null,
    status: 'not-observed',
    startedAt: null,
    completedAt: null,
    durationMs: null,
    tools: {
      policyStatus: 'unavailable', mode: null, allowed: [],
      observedCalls: null, observation: 'Tool-call execution is not captured for this handoff.'
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
    error: null
  };
  const input = numericUsage(invocation.usage, 'inputTokens');
  const output = numericUsage(invocation.usage, 'outputTokens');
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
      observedCalls: null,
      observation: 'The invocation audit records tool authorization, not individual tool calls.'
    },
    tokens: {
      status: invocation.usage?.status ?? (total == null ? 'unavailable' : 'exact'),
      assurance: invocation.usage?.assurance ?? (total == null ? 'unavailable' : 'provider-reported'),
      input,
      output,
      cachedInput: numericUsage(invocation.usage, 'cachedInputTokens'),
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
      encoding: invocation.promptEncoding ?? null
    },
    output: invocation.outputBytes == null ? null : {
      bytes: invocation.outputBytes, sha256: invocation.outputSha256 ?? null
    },
    error: invocation.error ?? null
  };
}

function matchingInvocation(record, invocations) {
  const linked = linkedInvocationId(record);
  if (linked) return invocations.find((entry) => entry.id === linked) ?? null;
  // Exact prompt bytes alone do not prove that a composition handoff became an invocation.
  // Hash fallback is reserved for invocation records written before the explicit evidence link.
  if (record.source !== 'model-invocation') return null;
  const matching = invocations.filter((entry) => entry.promptSha256 === record.promptSha256);
  if (matching.length < 2) return matching[0] ?? null;
  const at = Date.parse(record.recordedAt);
  return matching.sort((left, right) => (
    Math.abs(Date.parse(left.completedAt ?? left.startedAt) - at)
    - Math.abs(Date.parse(right.completedAt ?? right.startedAt) - at)
  ))[0];
}

async function enrichRecords(root, records) {
  const invocations = await invocationEntries(root);
  return records.map((record) => ({
    ...record,
    execution: executionProjection(record, matchingInvocation(record, invocations))
  }));
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
    '- Observed tool calls: unavailable',
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
    `- Secret redactions: ${record.redactions}`,
    `- Sent prompt bytes: ${execution.prompt?.bytes == null ? 'unavailable' : execution.prompt.bytes.toLocaleString('en-US')}`,
    `- Sent prompt SHA-256: ${display(execution.prompt?.sha256)}`,
    `- Prompt transport: ${display(execution.prompt?.transport)}`,
    `- Prompt encoding: ${display(execution.prompt?.encoding)}`,
    `- Timeout limit: ${execution.limits?.timeoutMs == null ? 'unavailable' : duration(execution.limits.timeoutMs)}`,
    `- Output limit: ${execution.limits?.outputBytes == null ? 'unavailable' : `${execution.limits.outputBytes.toLocaleString('en-US')} bytes`}`,
    `- Output bytes: ${execution.output?.bytes == null ? 'unavailable' : execution.output.bytes.toLocaleString('en-US')}`,
    `- Output SHA-256: ${display(execution.output?.sha256)}`,
    '',
    '## Grounding and references',
    '',
    `- Supporting evidence records: ${evidence.length}`,
    `- Governed references: ${references.length}`,
    `- Composition cache: ${record.compositionCache ? `${record.compositionCache.hit ? 'hit' : 'miss'} (${record.compositionCache.key})` : 'unavailable'}`,
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

export async function promptAuditStatus(root) {
  const target = await location(root);
  const config = await settings(target.settingsFile);
  const records = await entries(target.logFile);
  return {
    schemaVersion: PROMPT_AUDIT_SCHEMA_VERSION,
    enabled: config.enabled,
    updatedAt: config.updatedAt,
    count: records.length,
    latestAt: records.at(-1)?.recordedAt ?? null,
    ...target
  };
}

export async function setPromptAudit(root, enabled) {
  const target = await location(root);
  await mkdir(target.directory, { recursive: true });
  const value = {
    schemaVersion: PROMPT_AUDIT_SCHEMA_VERSION,
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString()
  };
  await writeAtomic(target.settingsFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return promptAuditStatus(root);
}

export async function recordPromptAudit(root, input) {
  const status = await promptAuditStatus(root);
  if (!status.enabled) return null;
  const scrubbed = scrubPrompt(input.prompt);
  const recordedAt = new Date().toISOString();
  const promptSha256 = createHash('sha256').update(scrubbed.prompt).digest('hex');
  const record = {
    schemaVersion: PROMPT_AUDIT_SCHEMA_VERSION,
    id: `${recordedAt.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`,
    recordedAt,
    workspaceId: status.workspaceId,
    workspaceName: status.workspaceName,
    repositoryPath: status.repositoryPath,
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
    promptSha256,
    bytes: Buffer.byteLength(scrubbed.prompt),
    redactions: scrubbed.redactions,
    prompt: scrubbed.prompt
  };
  await mkdir(status.directory, { recursive: true });
  await appendFile(status.logFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export async function listPromptAudits(root, filters = {}) {
  const status = await promptAuditStatus(root);
  const limit = Math.max(1, Math.min(Number(filters.limit ?? 100), 1000));
  let records = await entries(status.logFile);
  for (const key of ['agent', 'phase', 'workId']) {
    if (filters[key]) records = records.filter((record) => record[key] === filters[key]);
  }
  records = await enrichRecords(root, records.slice(-limit).reverse());
  if (!filters.includePrompt) records = records.map(({ prompt: _prompt, ...record }) => record);
  return { ...status, records };
}

export async function readPromptAudit(root, id = 'latest') {
  const status = await promptAuditStatus(root);
  const records = await entries(status.logFile);
  const record = id === 'latest' ? records.at(-1) : records.find((entry) => entry.id === id);
  if (!record) throw new SingularityFlowError(id === 'latest' ? 'No governed prompts have been captured.' : `Prompt-audit record '${id}' was not found.`);
  return { status, record: (await enrichRecords(root, [record]))[0] };
}
