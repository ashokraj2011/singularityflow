import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gitDir } from './git.mjs';
import { assertModelInvocationAllowed } from './operation-context.mjs';
import { modelProvider } from './model-provider-registry.mjs';
import {
  DEFAULT_MODEL_PROMPT_MAXIMUM_BYTES, stageModelPrompt
} from './model-prompt-transport.mjs';
import { assertModelTask } from './model-tasks.mjs';
import { loadModelTiers, MODEL_TIERS_PATH, tierLadder } from './model-tiers.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { nowIso, SingularityFlowError, writeJson } from './util.mjs';
import { prepareTelemetryLaunch } from './telemetry-provision.mjs';
import { repositoryLogger } from './logging.mjs';
import { recordPromptAudit } from './prompt-audit.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
    outputBytes: positiveInteger(request.limits?.outputBytes, 'limits.outputBytes'),
    promptBytes: request.limits?.promptBytes == null
      ? DEFAULT_MODEL_PROMPT_MAXIMUM_BYTES
      : positiveInteger(request.limits.promptBytes, 'limits.promptBytes')
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
  // A task is optional and additive: every caller that names a model directly still works. When one
  // is given it must be in the closed enum, refused here rather than deep in the mapping.
  if (request.task != null) assertModelTask(request.task, 'Model request task');
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
export async function listModelInvocations(root, {
  subjectId = null,
  phase = null,
  generationIntentId = null,
  generation = null,
  task = null,
  startedAfter = null
} = {}) {
  const directory = path.join(gitDir(root), 'singularity-flow', 'model-invocations');
  const names = await readdir(directory).catch(() => []);
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const text = await readFile(path.join(directory, name), 'utf8').catch(() => null);
    if (text === null) continue;
    let record = null;
    try { record = readRecord('model-invocation-audit', text).record; }
    catch (error) {
      if (String(error?.code ?? '').startsWith('SCHEMA_')) throw error;
      continue;
    }
    if (record?.status !== 'completed') continue;
    if (subjectId && record.subject?.id !== subjectId) continue;
    if (phase && record.subject?.phase !== phase) continue;
    if (generationIntentId && record.subject?.generationIntentId !== generationIntentId) continue;
    if (generation != null && Number(record.subject?.generation) !== Number(generation)) continue;
    if (task && record.routing?.task !== task) continue;
    if (startedAfter && (!record.startedAt || Date.parse(record.startedAt) < Date.parse(startedAfter))) continue;
    records.push(record);
  }
  return records.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
}

/**
 * Turn a task into a concrete model, here and nowhere else. `[ADP:REQ-032]`
 *
 * Resolution sits inside the chokepoint on purpose. Every model invocation already passes through
 * `invokeModel` under an operation context, so putting the lookup here means there is no second
 * place a model name can be chosen and no caller that can route itself somewhere the mapping does
 * not allow.
 *
 * A request may still name a model directly — every existing caller does, and this is additive —
 * but it may not do both. Naming a task *and* a model is a caller expressing a routing opinion, and
 * the whole point of the taxonomy is that callers do not have one.
 */
async function resolveRouting(normalized, root) {
  if (!normalized.task) return null;
  if (normalized.model) {
    throw new SingularityFlowError(
      `Model request names both task '${normalized.task}' and model '${normalized.model}'. A task resolves to a model through the mapping; naming both makes the mapping advisory.`,
      { code: 'MODEL_REQUEST_INVALID' }
    );
  }
  const mapping = await loadModelTiers(root);
  if (!mapping) {
    throw new SingularityFlowError(
      `Model request routes by task '${normalized.task}', but ${MODEL_TIERS_PATH} is not present. Task routing needs the mapping that resolves it.`,
      { code: 'MODEL_TIER_MISSING', details: { task: normalized.task } }
    );
  }
  const ladder = tierLadder(mapping, normalized.task);
  return {
    task: normalized.task,
    mappingRevision: mapping.revision,
    model: ladder.models[0],
    // Recorded even when nothing falls back, so a receipt shows what *could* have been used as well
    // as what was. The hops themselves arrive with the ladder in P3.
    available: [...ladder.models],
    hops: [],
    aliasOf: ladder.aliasOf,
    params: ladder.params,
    paramsDigest: ladder.paramsDigest
  };
}

async function captureInvocationPrompt(root, staged, event) {
  const prompt = await readFile(staged.file, 'utf8');
  return recordPromptAudit(root, {
    prompt,
    agent: event.subject?.agent ?? event.subject?.governedAgent ?? 'kernel-model',
    phase: event.subject?.phase ?? 'unscoped',
    generation: event.subject?.generation ?? null,
    workId: event.subject?.id ?? event.subject?.workId ?? null,
    workType: event.subject?.workType ?? null,
    task: event.routing?.task ?? null,
    source: 'model-invocation',
    supportingEvidence: [{ kind: 'model-invocation-audit', id: event.id }]
  });
}

export async function invokeModel(request) {
  const context = assertModelInvocationAllowed();
  const normalized = await normalizeRequest(request, context);
  const routing = await resolveRouting(normalized, context.root);
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
  const log = repositoryLogger(resolvedAuditRoot, null, { context: { invocationId: id } });
  const directory = path.join(gitDir(resolvedAuditRoot), 'singularity-flow', 'model-invocations');
  const file = path.join(directory, `${id}.json`);
  await mkdir(directory, { recursive: true });
  const staged = await stageModelPrompt(normalized.prompt, { maximumBytes: normalized.limits.promptBytes });
  log.info('model.prompt.staged', null, {
    provider: providerId, transport: 'attachment', promptBytes: staged.bytes
  });
  const event = {
    schemaVersion: currentSchemaVersion('model-invocation-audit'),
    id,
    operationId: context.operation.id,
    policy: context.effectivePolicy,
    modelMode: context.modelMode.enabled ? 'enabled' : 'disabled',
    rootOperationId: context.stack[0]?.id ?? context.operation.id,
    provider: providerId,
    model: routing?.model ?? normalized.model ?? null,
    // `[ADP:REQ-040]`: what was asked for, which mapping answered, what it resolved to, and what it
    // fell back through. Absent for a caller that named its model directly, which is how a reader
    // tells routed work from unrouted rather than having to infer it.
    routing: routing
      ? {
        task: routing.task,
        mappingRevision: routing.mappingRevision,
        resolvedModel: routing.model,
        aliasOf: routing.aliasOf,
        available: routing.available,
        fallbackHops: routing.hops,
        paramsDigest: routing.paramsDigest
      }
      : null,
    promptSha256: staged.sha256,
    promptBytes: staged.bytes,
    promptTransport: 'attachment',
    promptEncoding: staged.encoding,
    cwdSha256: sha256(normalized.cwd),
    channel: normalized.channel,
    subject: normalized.subject ?? null,
    toolPolicy: { mode: normalized.tools.mode, names: [...normalized.tools.names] },
    limits: normalized.limits,
    status: 'started',
    startedAt: nowIso(),
    completedAt: null
  };
  /**
   * The provider is asked for the model the routing chose. `[ADP:REQ-032]` `[ADP:AC-004]`
   *
   * It used to be handed `normalized`, which carries a `model` only when the caller named one — so
   * a task-routed invocation resolved `strong-model`, wrote `strong-model` into the receipt, told
   * the caller `strong-model`, and then ran the provider with no `--model` at all. The provider
   * used its own default, and every surface that exists to answer "which model did this work"
   * answered with a model nobody had requested.
   *
   * Nothing could see it. The receipt is written from `routing`, so it agreed with itself; the
   * fixture provider ignores its argv, so the assertions passed; and the two paths that *did*
   * differ — routed and caller-named — were only ever compared on the fields both derive from the
   * same source. It took reading the argv the provider actually received.
   *
   * The caller-named path is unchanged: `routing` is null there, and `normalized.model` already
   * held the answer.
   */
  let auditStarted = false;
  let providerStartedAt = null;
  try {
    // Audit is fail-closed: if this write fails, the provider is never started. Staged material is
    // still removed by the outer finally.
    await writeJson(file, event);
    auditStarted = true;
    const telemetryHost = normalized.channel.includes('vscode')
      ? 'vscode-terminal'
      : normalized.channel.includes('intellij') ? 'intellij-terminal' : 'cli';
    const telemetry = adapterId === 'copilot-cli'
      ? await prepareTelemetryLaunch({
        root: resolvedAuditRoot,
        story: normalized.subject?.id ?? normalized.subject?.workId ?? null,
        phase: normalized.subject?.phase ?? null,
        provider: 'github-copilot', runtime: 'copilot-cli', host: telemetryHost,
        surface: normalized.channel, baseEnv: process.env
      })
      : null;
    const invocation = Object.freeze({
      ...normalized,
      prompt: Object.freeze({
        file: staged.file, sha256: staged.sha256, bytes: staged.bytes,
        encoding: staged.encoding, staged: true
      }),
      promptTransport: 'attachment',
      ...(routing ? { model: routing.model } : {}),
      ...(telemetry ? { telemetry } : {})
    });
    providerStartedAt = Date.now();
    log.info('model.provider.started', null, {
      provider: providerId, transport: 'attachment', promptBytes: staged.bytes
    });
    const result = await provider(invocation);
    if (!result || typeof result !== 'object' || typeof result.output !== 'string') {
      throw new SingularityFlowError(`Model provider '${providerId}' returned an invalid result.`, { code: 'MODEL_PROVIDER_FAILED' });
    }
    const outputBytes = result.outputBytes ?? Buffer.byteLength(result.output ?? '', 'utf8');
    const outputSha256 = sha256(Buffer.from(result.output ?? '', 'utf8'));
    const completedAt = nowIso();
    const completedEvent = {
      ...event,
      status: 'completed',
      completedAt,
      outputBytes,
      outputSha256,
      usage: result.usage ?? { status: 'unavailable' }
    };
    await writeJson(file, completedEvent);
    await captureInvocationPrompt(resolvedAuditRoot, staged, completedEvent).catch((error) => {
      log.warn('model.prompt.audit-failed', null, { errorCode: error.code ?? 'PROMPT_AUDIT_FAILED' });
    });
    log.info('model.provider.completed', null, {
      provider: providerId, transport: 'attachment', promptBytes: staged.bytes,
      durationMs: Date.now() - providerStartedAt, exitCode: result.status ?? 0, signal: result.signal ?? null
    });
    return {
      schemaVersion: 1, // schema-transient: provider result envelope, never persisted
      invocationId: id,
      operationId: context.operation.id,
      provider: providerId,
      // The resolved model, not the requested one. A routed request names no model, so reporting
      // `request.model` here would hand every caller `null` for exactly the invocations whose model
      // was chosen for them — the one case where they most need to be told which model ran.
      model: event.model,
      routing: event.routing,
      status: 'completed',
      output: result.output,
      diagnostics: result.diagnostics ?? '',
      outputBytes,
      outputSha256,
      usage: result.usage ?? { status: 'unavailable' },
      startedAt: event.startedAt,
      completedAt,
      invocation: { id, path: file, provider: providerId, model: event.model }
    };
  } catch (error) {
    if (auditStarted) {
      const failedEvent = {
        ...event,
        status: 'failed',
        completedAt: nowIso(),
        error: { code: error.code ?? 'MODEL_PROVIDER_FAILED' }
      };
      await writeJson(file, failedEvent).catch(() => {});
      await captureInvocationPrompt(resolvedAuditRoot, staged, failedEvent).catch((auditError) => {
        log.warn('model.prompt.audit-failed', null, { errorCode: auditError.code ?? 'PROMPT_AUDIT_FAILED' });
      });
    }
    if (providerStartedAt != null) log.info('model.provider.failed', null, {
      provider: providerId, transport: 'attachment', promptBytes: staged.bytes,
      durationMs: Date.now() - providerStartedAt, exitCode: error?.details?.status ?? null,
      signal: error?.details?.signal ?? null, errorCode: error?.code ?? 'MODEL_PROVIDER_FAILED'
    });
    throw error;
  } finally {
    // Cleanup is best-effort and never replaces the provider or audit outcome.
    let cleanupError = null;
    await staged.cleanup().catch((error) => { cleanupError = error; });
    log.info('model.prompt.cleaned', null, {
      provider: providerId, transport: 'attachment', promptBytes: staged.bytes,
      errorCode: cleanupError?.code ?? null
    });
  }
}
