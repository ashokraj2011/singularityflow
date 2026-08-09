import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gitDir } from './git.mjs';
import { assertModelInvocationAllowed } from './operation-context.mjs';
import { modelProvider } from './model-provider-registry.mjs';
import { nowIso, SingularityFlowError, writeJson } from './util.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function promptFingerprint(prompt) {
  if (!prompt || (typeof prompt.text === 'string') === Boolean(prompt.file)) {
    throw new SingularityFlowError('Model request requires exactly one of prompt.text or prompt.file.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (typeof prompt?.text === 'string') {
    const bytes = Buffer.from(prompt.text, 'utf8');
    return { sha256: sha256(bytes), bytes: bytes.length };
  }
  if (!prompt?.file) throw new SingularityFlowError('Model request requires prompt.text or prompt.file.', { code: 'MODEL_REQUEST_INVALID' });
  const info = await lstat(prompt.file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new SingularityFlowError('Model prompt file must be a regular non-symbolic file.', { code: 'MODEL_REQUEST_INVALID' });
  const bytes = await readFile(prompt.file);
  return { sha256: sha256(bytes), bytes: bytes.length };
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SingularityFlowError(`Model request ${label} must be a positive integer.`, { code: 'MODEL_REQUEST_INVALID' });
  }
  return value;
}

async function normalizeRequest(request, context) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new SingularityFlowError('Model request must be an object.', { code: 'MODEL_REQUEST_INVALID' });
  }
  const provider = request.provider;
  if (typeof provider !== 'string' || !provider.trim()) {
    throw new SingularityFlowError('Model request requires a provider ID.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd)) {
    throw new SingularityFlowError('Model request cwd must be an absolute path.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (typeof request.channel !== 'string' || !request.channel.trim()) {
    throw new SingularityFlowError('Model request requires a non-empty channel.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (request.providerConfig != null && (!request.providerConfig || typeof request.providerConfig !== 'object' || Array.isArray(request.providerConfig))) {
    throw new SingularityFlowError('Model request providerConfig must be an object.', { code: 'MODEL_REQUEST_INVALID' });
  }
  const toolMode = request.tools?.mode;
  if (!['none', 'allowlist', 'all'].includes(toolMode)) {
    throw new SingularityFlowError('Model request tools.mode must be none, allowlist, or all.', { code: 'MODEL_REQUEST_INVALID' });
  }
  const toolNames = request.tools?.names ?? [];
  if (!Array.isArray(toolNames) || toolNames.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new SingularityFlowError('Model request tools.names must be an array of non-empty strings.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (toolMode === 'none' && toolNames.length) {
    throw new SingularityFlowError('Model request tools.names must be empty when tools.mode is none.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (toolMode === 'allowlist' && !toolNames.length) {
    throw new SingularityFlowError('Model request tools.names must not be empty when tools.mode is allowlist.', { code: 'MODEL_REQUEST_INVALID' });
  }
  const limits = {
    timeoutMs: positiveInteger(request.limits?.timeoutMs, 'limits.timeoutMs'),
    outputBytes: positiveInteger(request.limits?.outputBytes, 'limits.outputBytes')
  };
  const roots = request.allowedRoots?.length ? request.allowedRoots : [context.root].filter(Boolean);
  if (!roots.length || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new SingularityFlowError('Model request requires absolute allowedRoots.', { code: 'MODEL_REQUEST_INVALID' });
  }
  const resolvedCwd = await realpath(request.cwd).catch(() => null);
  const resolvedRoots = (await Promise.all(roots.map((root) => realpath(root).catch(() => null)))).filter(Boolean);
  if (!resolvedCwd || !resolvedRoots.some((root) => inside(resolvedCwd, root))) {
    throw new SingularityFlowError(`Model working directory is outside the operation's allowed roots: ${request.cwd}`, { code: 'MODEL_CWD_FORBIDDEN' });
  }
  if (request.prompt?.file) {
    const resolvedPrompt = await realpath(request.prompt.file).catch(() => null);
    if (!resolvedPrompt || !resolvedRoots.some((root) => inside(resolvedPrompt, root))) {
      throw new SingularityFlowError('Model prompt file is outside the operation allowed roots.', { code: 'MODEL_REQUEST_INVALID' });
    }
  }
  return Object.freeze({
    ...request,
    provider: provider.trim(),
    cwd: resolvedCwd,
    allowedRoots: Object.freeze(resolvedRoots),
    channel: request.channel.trim(),
    tools: Object.freeze({ mode: toolMode, names: Object.freeze([...toolNames]) }),
    limits: Object.freeze(limits)
  });
}

/**
 * The configured model provider, resolved the one way for every caller.
 *
 * Call sites used to each spell this out, and one of them — `workspace impact analyze` — never did,
 * so it silently spawned bare `copilot` from PATH while `doctor` reported the configured corporate
 * binary as the provider in use.
 */
export function resolveModelProvider(definition) {
  const provider = definition?.models?.defaultProvider ?? 'copilot-cli';
  const providerConfig = definition?.models?.providers?.[provider] ?? null;
  return { provider, providerConfig, model: providerConfig?.model ?? null };
}

/**
 * Completed model invocations recorded for a subject, oldest first.
 *
 * The audit store has been written on every invocation since it was introduced and read by nothing,
 * so `authorship.kernelModel.invoked` was a constant `false` — including for phases where the
 * kernel model demonstrably ran — and that constant was then sealed into the immutable review
 * packet. This is the reader that closes the loop.
 */
export async function listModelInvocations(root, { subjectId = null } = {}) {
  const directory = path.join(gitDir(root), 'singularity-flow', 'model-invocations');
  const names = await readdir(directory).catch(() => []);
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const text = await readFile(path.join(directory, name), 'utf8').catch(() => null);
    if (text === null) continue;
    let record = null;
    try { record = JSON.parse(text); } catch { continue; }
    if (record?.status !== 'completed') continue;
    if (subjectId && record.subject?.id !== subjectId) continue;
    records.push(record);
  }
  return records.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
}

export async function invokeModel(request) {
  const context = assertModelInvocationAllowed();
  const normalized = await normalizeRequest(request, context);
  const providerId = normalized.provider;
  const adapterId = normalized.providerConfig?.type ?? providerId;
  // Unknown providers are rejected before audit directory creation or process start.
  const provider = modelProvider(adapterId);
  const id = randomUUID();
  if (!context.root) throw new SingularityFlowError('Model invocation requires a trusted operation audit root.', { code: 'MODEL_AUDIT_ROOT_MISSING' });
  const trustedAuditRoot = await realpath(context.root).catch(() => null);
  const requestedAuditRoot = await realpath(normalized.auditRoot ?? context.root).catch(() => null);
  if (!trustedAuditRoot || !requestedAuditRoot || trustedAuditRoot !== requestedAuditRoot) {
    throw new SingularityFlowError('Model invocation audit root must be the trusted operation root.', { code: 'MODEL_AUDIT_ROOT_INVALID' });
  }
  const resolvedAuditRoot = trustedAuditRoot;
  const directory = path.join(gitDir(resolvedAuditRoot), 'singularity-flow', 'model-invocations');
  const file = path.join(directory, `${id}.json`);
  await mkdir(directory, { recursive: true });
  const fingerprint = await promptFingerprint(normalized.prompt);
  const event = {
    schemaVersion: 1,
    id,
    operationId: context.operation.id,
    policy: context.effectivePolicy,
    modelMode: context.modelMode.enabled ? 'enabled' : 'disabled',
    rootOperationId: context.stack[0]?.id ?? context.operation.id,
    provider: providerId,
    model: normalized.model ?? null,
    promptSha256: fingerprint.sha256,
    promptBytes: fingerprint.bytes,
    cwdSha256: sha256(normalized.cwd),
    channel: normalized.channel,
    subject: normalized.subject ?? null,
    toolPolicy: { mode: normalized.tools.mode, names: [...normalized.tools.names] },
    limits: normalized.limits,
    status: 'started',
    startedAt: nowIso(),
    completedAt: null
  };
  // Audit is fail-closed: if this write fails, the provider is never started.
  await writeJson(file, event);
  try {
    const result = await provider(normalized);
    if (!result || typeof result !== 'object' || typeof result.output !== 'string') {
      throw new SingularityFlowError(`Model provider '${providerId}' returned an invalid result.`, { code: 'MODEL_PROVIDER_FAILED' });
    }
    const outputBytes = result.outputBytes ?? Buffer.byteLength(result.output ?? '', 'utf8');
    const outputSha256 = sha256(Buffer.from(result.output ?? '', 'utf8'));
    const completedAt = nowIso();
    await writeJson(file, {
      ...event,
      status: 'completed',
      completedAt,
      outputBytes,
      outputSha256,
      usage: result.usage ?? { status: 'unavailable' }
    });
    return {
      schemaVersion: 1,
      invocationId: id,
      operationId: context.operation.id,
      provider: providerId,
      model: normalized.model ?? null,
      status: 'completed',
      output: result.output,
      diagnostics: result.diagnostics ?? '',
      outputBytes,
      outputSha256,
      usage: result.usage ?? { status: 'unavailable' },
      startedAt: event.startedAt,
      completedAt,
      invocation: { id, path: file, provider: providerId, model: request.model ?? null }
    };
  } catch (error) {
    await writeJson(file, {
      ...event,
      status: 'failed',
      completedAt: nowIso(),
      error: { code: error.code ?? 'MODEL_PROVIDER_FAILED' }
    });
    throw error;
  }
}
