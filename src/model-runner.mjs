import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir, gitDir } from './git.mjs';
import { assertModelInvocationAllowed } from './operation-context.mjs';
import { modelProvider } from './model-provider-registry.mjs';
import { COPILOT_MINIMUM_AI_CREDITS } from './model-limits.mjs';
import { resolveModelPromptTransport } from './model-provider-capability.mjs';
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
import { canonicalJson } from './records.mjs';
import { assessTokenAdmission } from './token-admission.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function auditKeyPath(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'keys', 'model-observation.key');
}

async function modelAuditKey(root) {
  const target = auditKeyPath(root);
  let key = await readFile(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!key) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const candidate = randomBytes(32);
    try {
      const handle = await open(target, 'wx', 0o600);
      try { await handle.writeFile(candidate); }
      finally { await handle.close(); }
      key = candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      key = await readFile(target);
    }
  }
  if (key.length !== 32) throw new SingularityFlowError('Model observation key is invalid.', { code: 'MODEL_AUDIT_KEY_INVALID' });
  return key;
}

function auditAttestationPayload(record) {
  const copy = structuredClone(record);
  delete copy.attestation;
  return canonicalJson(copy);
}

async function attestAudit(root, record) {
  const key = await modelAuditKey(root);
  const payload = auditAttestationPayload(record);
  return {
    ...record,
    attestation: {
      scheme: 'kernel-hmac-sha256-v1',
      keyId: `sha256:${sha256(key)}`,
      payloadSha256: `sha256:${sha256(payload)}`,
      mac: `sha256:${createHmac('sha256', key).update(payload).digest('hex')}`
    }
  };
}

async function verifyAuditAttestation(root, record) {
  const attestation = record?.attestation;
  if (attestation?.scheme !== 'kernel-hmac-sha256-v1') return false;
  const key = await modelAuditKey(root).catch(() => null);
  if (!key || attestation.keyId !== `sha256:${sha256(key)}`) return false;
  const payload = auditAttestationPayload(record);
  if (attestation.payloadSha256 !== `sha256:${sha256(payload)}`) return false;
  const expected = Buffer.from(createHmac('sha256', key).update(payload).digest('hex'), 'hex');
  const actualHex = String(attestation.mac ?? '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(actualHex)) return false;
  return timingSafeEqual(expected, Buffer.from(actualHex, 'hex'));
}

function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function canonicalScopePath(value, cwd) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new SingularityFlowError('Model tool-scope paths must be non-empty absolute paths.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  const target = path.resolve(cwd, value);
  if (!path.isAbsolute(value)) {
    throw new SingularityFlowError('Model tool-scope paths must be absolute.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  const missing = [];
  let ancestor = target;
  for (;;) {
    const resolved = await realpath(ancestor).catch((error) => (
      error?.code === 'ENOENT' ? null : Promise.reject(error)
    ));
    if (resolved) return path.join(resolved, ...missing);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new SingularityFlowError(`Model tool-scope path cannot be resolved: ${value}`, {
        code: 'MODEL_REQUEST_INVALID'
      });
    }
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}

async function normalizeToolScope(scope, { cwd, allowedRoots, toolMode }) {
  if (scope == null) return null;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new SingularityFlowError('Model request tools.scope must be an object.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  const normalized = {};
  for (const field of ['readRoots', 'writeRoots']) {
    const values = scope[field] ?? [];
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== 'string')) {
      throw new SingularityFlowError(`Model request tools.scope.${field} must be an array of absolute paths.`, {
        code: 'MODEL_REQUEST_INVALID'
      });
    }
    const canonical = [...new Set(await Promise.all(values.map((entry) => canonicalScopePath(entry, cwd))))]
      .sort();
    if (canonical.some((entry) => !allowedRoots.some((root) => inside(entry, root)))) {
      throw new SingularityFlowError(`Model request tools.scope.${field} escapes allowedRoots.`, {
        code: 'MODEL_TOOL_SCOPE_FORBIDDEN'
      });
    }
    normalized[field] = Object.freeze(canonical);
  }
  if (toolMode !== 'none' && normalized.readRoots.length === 0) {
    throw new SingularityFlowError('A scoped model tool policy requires at least one read root.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  return Object.freeze({
    protocol: 'path-v1',
    readRoots: normalized.readRoots,
    writeRoots: normalized.writeRoots
  });
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SingularityFlowError(`Model request ${label} must be a positive integer.`, { code: 'MODEL_REQUEST_INVALID' });
  }
  return value;
}

function automaticPositiveInteger(value, fallback, label) {
  if (value == null) return fallback;
  if (value === 'auto') return value;
  return positiveInteger(value, label);
}

const DEFAULT_MODEL_LIMITS = Object.freeze({
  tools: Object.freeze({
    maxToolCalls: 64,
    maxTurns: 16,
    maxTotalTokens: 250_000,
    maxToolResultBytes: 1024 * 1024,
    maxAiCredits: COPILOT_MINIMUM_AI_CREDITS
  }),
  relay: Object.freeze({
    maxToolCalls: 1,
    maxTurns: 3,
    maxTotalTokens: 64_000,
    maxToolResultBytes: 64 * 1024,
    maxAiCredits: COPILOT_MINIMUM_AI_CREDITS
  })
});

function observedUsage(usage, field) {
  const direct = usage?.[field];
  if (Number.isFinite(direct) && direct >= 0) return Number(direct);
  const observed = usage?.observations?.[field]?.value;
  return Number.isFinite(observed) && observed >= 0 ? Number(observed) : null;
}

function invocationEconomics(promptBytes, usage = null) {
  const inputTokens = observedUsage(usage, 'inputTokens');
  const outputTokens = observedUsage(usage, 'outputTokens');
  const cachedInputTokens = observedUsage(usage, 'cachedInputTokens');
  const reasoningTokens = observedUsage(usage, 'reasoningTokens');
  const uncachedInputTokens = inputTokens != null && cachedInputTokens != null
    && cachedInputTokens <= inputTokens ? inputTokens - cachedInputTokens : null;
  return {
    source: {
      sourceBytes: null, managedSourceBytesExcluded: null,
      assurance: 'unavailable-at-provider-boundary'
    },
    prompt: {
      candidatePromptBytes: promptBytes, deduplicatedPromptBytes: 0,
      budgetEvictedPromptBytes: 0, finalPromptBytes: promptBytes,
      assurance: 'sflow-measured'
    },
    provider: {
      inputTokens, outputTokens, cachedInputTokens, uncachedInputTokens, reasoningTokens,
      totalTokens: observedUsage(usage, 'totalTokens')
        ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
      providerCost: Number.isFinite(usage?.providerCost) ? usage.providerCost : null,
      assurance: inputTokens == null && outputTokens == null
        ? 'unavailable' : usage?.assurance ?? 'provider-reported'
    },
    system: { totalSystemTokens: null, assurance: 'unavailable' }
  };
}

function boundaryPromptLayout(staged) {
  const section = {
    id: 'provider-request-prompt', mandatory: true, bytes: staged.bytes,
    sha256: staged.sha256, reason: 'selected-at-model-boundary'
  };
  return {
    boundary: 'model-runner',
    candidate: [section],
    mandatory: [section],
    selected: [section],
    omitted: [],
    unavailable: [],
    expanded: []
  };
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
  for (const field of ['requireSuccessful', 'rejectTruncated']) {
    if (request.tools?.[field] != null && typeof request.tools[field] !== 'boolean') {
      throw new SingularityFlowError(`Model request tools.${field} must be boolean.`, { code: 'MODEL_REQUEST_INVALID' });
    }
  }
  const defaultLimits = toolMode === 'none' ? DEFAULT_MODEL_LIMITS.relay : DEFAULT_MODEL_LIMITS.tools;
  const limits = {
    timeoutMs: positiveInteger(request.limits?.timeoutMs, 'limits.timeoutMs'),
    outputBytes: positiveInteger(request.limits?.outputBytes, 'limits.outputBytes'),
    promptBytes: request.limits?.promptBytes == null
      ? DEFAULT_MODEL_PROMPT_MAXIMUM_BYTES
      : positiveInteger(request.limits.promptBytes, 'limits.promptBytes'),
    maxToolCalls: automaticPositiveInteger(
      request.limits?.maxToolCalls, defaultLimits.maxToolCalls, 'limits.maxToolCalls'
    ),
    maxTurns: automaticPositiveInteger(
      request.limits?.maxTurns, defaultLimits.maxTurns, 'limits.maxTurns'
    ),
    maxTotalTokens: automaticPositiveInteger(
      request.limits?.maxTotalTokens, defaultLimits.maxTotalTokens, 'limits.maxTotalTokens'
    ),
    maxToolResultBytes: request.limits?.maxToolResultBytes == null
      ? defaultLimits.maxToolResultBytes : positiveInteger(request.limits.maxToolResultBytes, 'limits.maxToolResultBytes'),
    maxAiCredits: automaticPositiveInteger(
      request.limits?.maxAiCredits, defaultLimits.maxAiCredits, 'limits.maxAiCredits'
    )
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
  const toolScope = await normalizeToolScope(request.tools?.scope, {
    cwd: resolvedCwd, allowedRoots: resolvedRoots, toolMode
  });
  // A task is optional and additive: every caller that names a model directly still works. When one
  // is given it must be in the closed enum, refused here rather than deep in the mapping.
  if (request.task != null) assertModelTask(request.task, 'Model request task');
  if (request.tokenAdmission != null
      && (!request.tokenAdmission || typeof request.tokenAdmission !== 'object'
        || Array.isArray(request.tokenAdmission))) {
    throw new SingularityFlowError('Model request tokenAdmission must be an object.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (request.tokenAdmission?.mode != null
      && !['observe', 'enforce'].includes(request.tokenAdmission.mode)) {
    throw new SingularityFlowError('Model request tokenAdmission.mode must be observe or enforce.', { code: 'MODEL_REQUEST_INVALID' });
  }
  return Object.freeze({
    ...request,
    provider: provider.trim(),
    cwd: resolvedCwd,
    allowedRoots: Object.freeze(resolvedRoots),
    channel: request.channel.trim(),
    tools: Object.freeze({
      mode: toolMode, names: Object.freeze([...toolNames]),
      requireSuccessful: toolMode !== 'none' && request.tools?.requireSuccessful !== false,
      rejectTruncated: toolMode !== 'none' && request.tools?.rejectTruncated !== false,
      ...(toolScope ? { scope: toolScope } : {})
    }),
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
    records.push({
      ...record,
      // This detects accidental/local-file tampering, but the key is machine-local and readable by
      // the same OS identity. It is deliberately not promoted to independent strong assurance.
      observationIntegrity: await verifyAuditAttestation(root, record) ? 'machine-local-mac' : 'unverified-local'
    });
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

function canTryMappedFallback(error) {
  // A fallback is an approved substitute for a retired/unavailable model, not a way around auth,
  // policy, network, tool, timeout, cancellation, or malformed-output failures.
  return error?.code === 'MODEL_NOT_AVAILABLE';
}

export async function invokeModel(request) {
  const context = assertModelInvocationAllowed();
  const normalized = await normalizeRequest(request, context);
  const routing = await resolveRouting(normalized, context.root);
  const providerId = normalized.provider;
  const adapterId = normalized.providerConfig?.type ?? providerId;
  // Unknown providers are rejected before audit directory creation or process start.
  const provider = modelProvider(adapterId);
  // Resolve the confidential prompt transport before creating an invocation receipt, staging a
  // prompt, or starting any provider worker. In particular, the presence of --attachment is not
  // treated as proof that current Copilot releases accept text files.
  const transportResolution = resolveModelPromptTransport(normalized.providerConfig, adapterId);
  const promptTransport = transportResolution.transport;
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
  const admission = assessTokenAdmission({
    ...(normalized.tokenAdmission ?? {}),
    model: routing?.model ?? normalized.model ?? null,
    logicalPromptBytes: staged.bytes
  });
  log.info('model.prompt.staged', null, {
    provider: providerId, transport: promptTransport, promptBytes: staged.bytes
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
    requestedModel: routing?.model ?? normalized.model ?? normalized.providerConfig?.model ?? 'auto',
    modelSelection: null,
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
    promptTransport,
    promptProtocolVersion: null,
    promptEncoding: staged.encoding,
    promptLayout: boundaryPromptLayout(staged),
    tokenAdmission: admission,
    economics: invocationEconomics(staged.bytes),
    cwdSha256: sha256(normalized.cwd),
    channel: normalized.channel,
    subject: normalized.subject ?? null,
    generationNonce: randomBytes(24).toString('base64url'),
    toolPolicy: {
      mode: normalized.tools.mode, names: [...normalized.tools.names],
      requireSuccessful: normalized.tools.requireSuccessful,
      rejectTruncated: normalized.tools.rejectTruncated,
      ...(normalized.tools.scope ? { scope: {
        protocol: normalized.tools.scope.protocol,
        read: {
          count: normalized.tools.scope.readRoots.length,
          sha256: `sha256:${sha256(canonicalJson(normalized.tools.scope.readRoots))}`
        },
        write: {
          count: normalized.tools.scope.writeRoots.length,
          sha256: `sha256:${sha256(canonicalJson(normalized.tools.scope.writeRoots))}`
        }
      } } : {})
    },
    toolObservation: null,
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
  let auditModel = event.model;
  let auditRouting = event.routing;
  try {
    // Audit is fail-closed: if this write fails, the provider is never started. Staged material is
    // still removed by the outer finally.
    await writeJson(file, event);
    auditStarted = true;
    // When prompt capture is enabled it is part of the same fail-closed boundary. Record the exact
    // staged bytes before provider start so a crash, kill, or provider hang cannot leave an
    // invocation receipt with no corresponding prompt record.
    await captureInvocationPrompt(resolvedAuditRoot, staged, event);
    if (normalized.tokenAdmission?.mode === 'enforce') {
      if (!admission.safeToEnforce || admission.maximumInputTokens == null) {
        throw new SingularityFlowError(
          'Model invocation cannot enforce a context boundary without complete tokenizer/provider admission evidence.',
          { code: 'TKN_ADMISSION_ASSURANCE_INSUFFICIENT', details: { admission } }
        );
      }
      if (admission.admitted !== true) {
        throw new SingularityFlowError(
          'Model invocation exceeds the admitted provider context boundary.',
          { code: 'TKN_PROVIDER_CONTEXT_OVERFLOW', details: { admission } }
        );
      }
    }
    const telemetryHost = normalized.channel.includes('vscode')
      ? 'vscode-terminal'
      : normalized.channel.includes('intellij') ? 'intellij-terminal' : 'cli';
    const candidates = routing?.available?.length
      ? [...routing.available]
      : [normalized.model ?? normalized.providerConfig?.model ?? null];
    const fallbackHops = [];
    let result = null;
    let resolvedModel = candidates[0] ?? null;
    let completedRouting = event.routing;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      auditModel = candidate;
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
        promptTransport,
        ...(candidate ? { model: candidate } : {}),
        ...(telemetry ? { telemetry } : {})
      });
      providerStartedAt = Date.now();
      log.info('model.provider.started', null, {
        provider: providerId, model: candidate, attempt: index + 1,
        transport: promptTransport, promptBytes: staged.bytes
      });
      try {
        result = await provider(invocation);
        log.info('model.provider.completed', null, {
          provider: providerId, model: candidate, attempt: index + 1,
          transport: promptTransport, promptBytes: staged.bytes,
          durationMs: Date.now() - providerStartedAt,
          exitCode: result?.status ?? 0, signal: result?.signal ?? null
        });
        providerStartedAt = null;
        resolvedModel = result.model ?? candidate ?? result.requestedModel ?? 'auto';
        break;
      } catch (error) {
        log.info('model.provider.failed', null, {
          provider: providerId, model: candidate, attempt: index + 1,
          transport: promptTransport, promptBytes: staged.bytes,
          durationMs: Date.now() - providerStartedAt,
          exitCode: error?.details?.status ?? null, signal: error?.details?.signal ?? null,
          errorCode: error?.code ?? 'MODEL_PROVIDER_FAILED'
        });
        providerStartedAt = null;
        const hasFallback = Boolean(routing && index + 1 < candidates.length);
        if (!hasFallback || !canTryMappedFallback(error)) throw error;
        fallbackHops.push(candidate);
        completedRouting = { ...event.routing, fallbackHops: [...fallbackHops] };
        auditRouting = completedRouting;
        log.warn('model.provider.fallback', error.message, {
          provider: providerId, from: candidate, to: candidates[index + 1],
          task: routing.task, fallbackHops: [...fallbackHops]
        });
      }
    }
    if (!result || typeof result !== 'object' || typeof result.output !== 'string') {
      throw new SingularityFlowError(`Model provider '${providerId}' returned an invalid result.`, { code: 'MODEL_PROVIDER_FAILED' });
    }
    completedRouting = routing
      ? { ...event.routing, resolvedModel, fallbackHops: [...fallbackHops] }
      : null;
    auditModel = resolvedModel;
    auditRouting = completedRouting;
    // Count and hash the exact normalized output returned to callers. Provider stream counters may
    // include boundary whitespace that the transport intentionally discards.
    const outputBytes = Buffer.byteLength(result.output ?? '', 'utf8');
    const outputSha256 = sha256(Buffer.from(result.output ?? '', 'utf8'));
    const completedAt = nowIso();
    const completedEvent = await attestAudit(resolvedAuditRoot, {
      ...event,
      model: resolvedModel,
      requestedModel: result.requestedModel ?? event.requestedModel,
      modelSelection: result.modelSelection ?? {
        policy: (result.requestedModel ?? event.requestedModel) === 'auto' ? 'provider-auto' : 'sflow-selected',
        requestedModel: result.requestedModel ?? event.requestedModel,
        providerSelectedModel: null, resolvedModels: [], assurance: 'unavailable'
      },
      routing: completedRouting,
      promptTransport: result.promptTransport ?? promptTransport,
      promptProtocolVersion: result.promptProtocolVersion ?? null,
      status: 'completed',
      completedAt,
      outputBytes,
      outputSha256,
      usage: result.usage ?? { status: 'unavailable' },
      toolObservation: result.toolObservation ?? null,
      economics: invocationEconomics(staged.bytes, result.usage)
    });
    await writeJson(file, completedEvent);
    return {
      schemaVersion: 1, // schema-transient: provider result envelope, never persisted
      invocationId: id,
      operationId: context.operation.id,
      provider: providerId,
      // The resolved model, not the requested one. A routed request names no model, so reporting
      // `request.model` here would hand every caller `null` for exactly the invocations whose model
      // was chosen for them — the one case where they most need to be told which model ran.
      model: resolvedModel,
      requestedModel: completedEvent.requestedModel,
      modelSelection: completedEvent.modelSelection,
      routing: completedRouting,
      status: 'completed',
      output: result.output,
      diagnostics: result.diagnostics ?? '',
      outputBytes,
      outputSha256,
      usage: result.usage ?? { status: 'unavailable' },
      toolObservation: completedEvent.toolObservation,
      tokenAdmission: admission,
      economics: completedEvent.economics,
      promptTransport: completedEvent.promptTransport,
      promptProtocolVersion: completedEvent.promptProtocolVersion,
      startedAt: event.startedAt,
      completedAt,
      invocation: { id, path: file, provider: providerId, model: resolvedModel }
    };
  } catch (error) {
    if (auditStarted) {
      const failedEvent = await attestAudit(resolvedAuditRoot, {
        ...event,
        model: auditModel,
        routing: auditRouting,
        modelSelection: error?.details?.modelSelection ?? event.modelSelection,
        toolObservation: error?.details?.toolObservation ?? event.toolObservation,
        promptProtocolVersion: error?.details?.promptProtocolVersion ?? event.promptProtocolVersion,
        usage: error?.details?.usage ?? { status: 'unavailable' },
        economics: invocationEconomics(staged.bytes, error?.details?.usage),
        status: 'failed',
        completedAt: nowIso(),
        error: { code: error.code ?? 'MODEL_PROVIDER_FAILED' }
      }).catch(() => ({ ...event, status: 'failed', completedAt: nowIso(), error: { code: error.code ?? 'MODEL_PROVIDER_FAILED' } }));
      await writeJson(file, failedEvent).catch(() => {});
    }
    if (providerStartedAt != null) log.info('model.provider.failed', null, {
      provider: providerId, transport: promptTransport, promptBytes: staged.bytes,
      durationMs: Date.now() - providerStartedAt, exitCode: error?.details?.status ?? null,
      signal: error?.details?.signal ?? null, errorCode: error?.code ?? 'MODEL_PROVIDER_FAILED'
    });
    throw error;
  } finally {
    // Cleanup is best-effort and never replaces the provider or audit outcome.
    let cleanupError = null;
    await staged.cleanup().catch((error) => { cleanupError = error; });
    log.info('model.prompt.cleaned', null, {
      provider: providerId, transport: promptTransport, promptBytes: staged.bytes,
      errorCode: cleanupError?.code ?? null
    });
  }
}
