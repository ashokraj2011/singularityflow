import * as acp from '@agentclientprotocol/sdk';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { TransformStream } from 'node:stream/web';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { isPreparedTelemetryLaunch, recordTelemetryLaunch } from '../telemetry-provision.mjs';
import { COPILOT_MINIMUM_AI_CREDITS } from '../model-limits.mjs';
import { redactDiagnosticText } from '../git-remote-diagnostics.mjs';
import { SingularityFlowError } from '../util.mjs';
import { VERSION } from '../version.mjs';
import { resolveModelProviderLaunch } from '../model-provider-launch.mjs';
import { tryWindowsTaskkill } from '../platform-process.mjs';

const DEFAULT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const SAFE_ENVIRONMENT = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'COMSPEC',
  'LANG', 'LC_ALL', 'TERM', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'GH_HOST', 'GITHUB_HOST', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
];

const SAFE_ENVIRONMENT_SET = new Set(SAFE_ENVIRONMENT);
const TEST_ENVIRONMENT = ['SFLOW_PARALLEL_TEST_LOG', 'SFLOW_MOCK_SKIP_PACKET_VIEW', 'SFLOW_MOCK_SKIP_ALL_PACKETS', 'SFLOW_MOCK_FAIL_SYNTHESIS',
  'SFLOW_MOCK_MANIFEST_RETRY_MARKER', 'SFLOW_MOCK_DIRECTORY_VIEW_RETRY_MARKER', 'SFLOW_MOCK_SHORT_SHA',
  'SFLOW_MOCK_REQUIRE_PRECREATED_OUTPUTS'];

export const COPILOT_ATTACHMENT_BOOTSTRAP_PROMPT = [
  'The attached UTF-8 Markdown file is the complete Singularity Flow request.',
  'Treat its full contents as the user request and execute it.',
  'Do not merely summarize or describe the attachment.'
].join(' ');

const RESERVED_OPTIONS = Object.freeze([
  '-p', '--prompt', '--attachment', '-C', '--model', '--available-tools', '--allow-tool',
  '--allow-all-tools', '--allow-all', '--allow-all-paths', '--allow-all-urls', '--yolo',
  '--add-dir', '--deny-tool', '--excluded-tools', '--additional-mcp-config',
  '--enable-all-github-mcp-tools', '--add-github-mcp-tool', '--add-github-mcp-toolset',
  '--plugin-dir', '--acp', '--stdio', '--max-ai-credits'
]);

const ACP_BOUNDARY_OPTIONS = Object.freeze([
  '--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user',
  '--no-remote', '--no-remote-export', '--no-auto-update'
]);

// The kernel uses one provider-independent tool vocabulary. Copilot CLI has its own host-native
// names, and --allow-tool accepts permission patterns rather than those tool names. Passing the
// canonical names through unchanged makes the model print tool-call markup while no tool actually
// runs. Keep the policy/audit vocabulary stable and translate only at this adapter boundary.
const COPILOT_TOOL_NAMES = Object.freeze({
  read_file: Object.freeze(['view']),
  search: Object.freeze(['grep']),
  edit_file: Object.freeze(['edit']),
  create_file: Object.freeze(['edit']),
  delete_file: Object.freeze(['edit']),
  move_file: Object.freeze(['edit']),
  copy_file: Object.freeze(['edit'])
});

const ACP_MUTATING_OPERATIONS = new Set([
  'edit_file', 'create_file', 'delete_file', 'move_file', 'copy_file'
]);

function unique(values) { return [...new Set(values)]; }

export function copilotToolArguments(tools = { mode: 'none', names: [] }) {
  if (tools.mode === 'none') return ['--available-tools='];
  if (tools.mode === 'all') {
    if (tools.scope) throw new SingularityFlowError(
      'Path-scoped model execution requires an explicit reviewed tool allowlist.', {
        code: 'MODEL_TOOL_SCOPE_UNSUPPORTED'
      }
    );
    return ['--allow-all-tools'];
  }
  const unsupported = tools.names.filter((name) => !COPILOT_TOOL_NAMES[name]);
  if (unsupported.length) {
    throw new SingularityFlowError(
      `Copilot CLI has no reviewed tool translation for: ${unsupported.join(', ')}.`,
      { code: 'MODEL_TOOL_UNSUPPORTED', details: { tools: unsupported } }
    );
  }
  const available = unique(tools.names.flatMap((name) => COPILOT_TOOL_NAMES[name]));
  const argumentsList = [`--available-tools=${available.join(',')}`];
  if (tools.names.some((name) => ACP_MUTATING_OPERATIONS.has(name))) {
    // Copilot's permission grammar authorizes file mutations as `write(...)`; `edit` is the
    // availability name, not a valid permission pattern. The request still has a bounded cwd,
    // allowed roots, an exact output contract, and the caller's post-run isolation check.
    // A path-scoped request must be decided through ACP request_permission for every effect.
    // Auto-allowing `write` here would bypass the only pre-effect message carrying the target path.
    if (!tools.scope) argumentsList.push('--allow-tool=write');
  }
  return argumentsList;
}

/** Give Copilot only the additional verified roots admitted by the kernel request boundary. */
export function copilotAllowedRootArguments(request) {
  const roots = request.allowedRoots ?? [request.cwd];
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string'
    || !root.trim() || !path.isAbsolute(root) || /[\r\n\0]/.test(root))) {
    throw new SingularityFlowError('Model provider allowed roots must be an array of absolute paths.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  return unique(roots).filter((root) => root !== request.cwd)
    .flatMap((root) => ['--add-dir', root]);
}

function copilotAiCreditArguments(limits = {}) {
  const credits = limits.maxAiCredits ?? COPILOT_MINIMUM_AI_CREDITS;
  // `auto` means that SFlow does not impose a provider credit ceiling. Copilot remains responsible
  // for the account's own entitlement, policy, and consent boundaries.
  if (credits === 'auto') return [];
  if (!Number.isSafeInteger(credits) || credits < COPILOT_MINIMUM_AI_CREDITS) {
    throw new SingularityFlowError(
      `Copilot CLI requires a model invocation limit of at least ${COPILOT_MINIMUM_AI_CREDITS} AI credits; received ${credits}.`,
      {
        code: 'MODEL_AI_CREDIT_LIMIT_UNSUPPORTED',
        details: { minimum: COPILOT_MINIMUM_AI_CREDITS, requested: credits }
      }
    );
  }
  return ['--max-ai-credits', String(credits)];
}

function boundedDiagnostic(value) {
  return redactDiagnosticText(value).trim().replace(/\s+/g, ' ').slice(0, 1024);
}

function unavailableModelDiagnostic(value) {
  return /(?:model\s+["'`]?.+?["'`]?\s+(?:is\s+)?not available|unknown model|unsupported model|model .+ has been (?:retired|disabled))/i.test(value);
}

function providerExitError(providerLabel, status, signal, diagnostics) {
  const diagnostic = boundedDiagnostic(diagnostics);
  const unavailable = unavailableModelDiagnostic(diagnostic);
  const exit = `${providerLabel} exited with status ${status}${signal ? ` (${signal})` : ''}`;
  return new SingularityFlowError(
    diagnostic ? `${exit}: ${diagnostic}` : `${exit}.`,
    {
      code: unavailable ? 'MODEL_NOT_AVAILABLE' : 'MODEL_EXIT_NONZERO',
      details: { status, signal, diagnostic: diagnostic || null }
    }
  );
}

function reservedOption(argument) {
  if (argument.startsWith('-p') && !argument.startsWith('--')) return '-p';
  if (argument.startsWith('-C') && !argument.startsWith('--')) return '-C';
  return RESERVED_OPTIONS.find((option) => argument === option || argument.startsWith(`${option}=`)) ?? null;
}

export function modelProviderStartErrorCode(nativeCode) {
  if (nativeCode === 'ENOENT') return 'MODEL_PROVIDER_UNAVAILABLE';
  if (nativeCode === 'EACCES' || nativeCode === 'EPERM') return 'MODEL_PROVIDER_NOT_EXECUTABLE';
  if (nativeCode === 'E2BIG') return 'MODEL_PROVIDER_ARGUMENT_LIMIT';
  return 'MODEL_PROVIDER_START_FAILED';
}

function providerEnvironment(overrides = {}, telemetry = null) {
  const forbidden = Object.keys(overrides).filter((key) => !SAFE_ENVIRONMENT_SET.has(key));
  if (forbidden.length) {
    throw new SingularityFlowError(`Model provider environment contains unsupported keys: ${forbidden.join(', ')}.`, {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  if (telemetry != null && !isPreparedTelemetryLaunch(telemetry)) {
    throw new SingularityFlowError('Model provider telemetry must come from trusted provisioning.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  const inherited = process.env.NODE_ENV === 'test' ? [...SAFE_ENVIRONMENT, ...TEST_ENVIRONMENT] : SAFE_ENVIRONMENT;
  return Object.fromEntries([
    ...inherited.filter((key) => process.env[key] != null).map((key) => [key, process.env[key]]),
    ...Object.entries(overrides),
    ...Object.entries(telemetry?.providerEnv ?? {})
  ]);
}

/**
 * Normalize only provider identities that Copilot was actually offered on argv. `kind` carries the
 * operation while `name` identifies the one host tool that implements it. Treating either field as
 * a fallback for a contradictory other field would let a completion relabel `edit` as `delete` (or
 * vice versa) after permission.
 */
function acpProviderOperation(toolCall) {
  const name = toolCall?.name ?? null;
  const kind = toolCall?.kind ?? null;
  const input = toolCall?.rawInput;
  const source = input?.source ?? input?.from ?? input?.src ?? input?.oldPath ?? input?.old_path;
  const destination = input?.destination ?? input?.to ?? input?.dst ?? input?.newPath ?? input?.new_path;
  const byKind = Object.freeze({
    read: { name: 'view', operation: 'read' },
    search: { name: 'grep', operation: 'search' },
    edit: { name: 'edit', operation: 'edit' },
    delete: { name: 'edit', operation: 'delete' },
    move: { name: 'edit', operation: 'move' },
    copy: { name: 'edit', operation: 'copy' }
  });
  if (kind != null) {
    // ACP v1 has no `copy` ToolKind. Its decoder converts an extension kind to `other`, so retain a
    // copy identity only when the offered `edit` tool also supplies both explicit path endpoints.
    // An unlabelled `other` call or a contradictory provider name remains unclassifiable.
    if (kind === 'other' && name === 'edit') {
      return source != null && destination != null ? 'copy' : null;
    }
    const expected = byKind[kind];
    if (!expected || (name != null && name !== expected.name)) return null;
    return expected.operation;
  }
  // The v1 SDK's forward-compatible decoder can also omit an unknown extension kind. Preserve only
  // the same unambiguous copy shape; a plain kind-less `edit` remains an edit below.
  if (name === 'edit' && source != null && destination != null) return 'copy';
  const byName = Object.freeze({ view: 'read', grep: 'search', edit: 'edit' });
  return byName[name] ?? null;
}

function boundedPathValue(value, cwd) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) return null;
  if (value.startsWith('file:')) {
    try { return fileURLToPath(value); } catch { return null; }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  return path.resolve(cwd, value);
}

function acpToolTargets(toolCall, cwd, operation = acpProviderOperation(toolCall)) {
  const input = toolCall?.rawInput;
  const targets = [];
  const add = (value, access) => {
    if (value == null) return;
    targets.push({ path: boundedPathValue(value, cwd), access });
  };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (operation === 'move' || operation === 'copy') {
      // Moving removes the source and is therefore a write at both ends. Copying only reads the
      // source. Treating a move source as read-only would let an agent delete from a read root.
      add(input.source ?? input.from ?? input.src ?? input.oldPath ?? input.old_path,
        operation === 'move' ? 'write' : 'read');
      add(input.destination ?? input.to ?? input.dst ?? input.newPath ?? input.new_path, 'write');
    } else {
      const access = operation === 'read' || operation === 'search' ? 'read' : 'write';
      for (const key of [
        'path', 'filePath', 'file_path', 'directory', 'cwd', 'root',
        'source', 'destination', 'from', 'to', 'oldPath', 'newPath',
        'old_path', 'new_path', 'src', 'dst'
      ]) add(input[key], access);
    }
  }
  if (Array.isArray(toolCall?.locations)) {
    const source = operation === 'copy'
      ? boundedPathValue(input?.source ?? input?.from ?? input?.src
        ?? input?.oldPath ?? input?.old_path, cwd)
      : null;
    for (const location of toolCall.locations) {
      const value = typeof location === 'string'
        ? location : location?.path ?? location?.uri ?? location?.filePath ?? location?.file_path;
      const located = boundedPathValue(value, cwd);
      // ACP locations describe affected paths but do not declare their access direction. For a
      // copy, the exact raw-input source remains read-only; every other affected location is an
      // effect. Unknown or extra paths consequently fail closed against the write scope.
      add(value, operation === 'read' || operation === 'search'
        || (operation === 'copy' && located === source)
        ? 'read' : 'write');
    }
  }
  if (!targets.length && operation === 'search') {
    targets.push({ path: cwd, access: 'read' });
  }
  return targets;
}

async function canonicalToolTarget(target) {
  let ancestor = target;
  const missing = [];
  for (;;) {
    const canonical = await realpath(ancestor).catch((error) => (
      error?.code === 'ENOENT' ? null : Promise.reject(error)
    ));
    if (canonical) return path.join(canonical, ...missing);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}

async function canonicalAcpOperation(toolCall, cwd, expectedOperation = null) {
  const providerOperation = acpProviderOperation(toolCall);
  if (!providerOperation) return null;
  if (providerOperation !== 'edit') return `${providerOperation}_file`.replace('search_file', 'search');
  if (['create_file', 'edit_file'].includes(expectedOperation)) return expectedOperation;
  const targets = acpToolTargets(toolCall, cwd, providerOperation)
    .filter((target) => target.access === 'write' && target.path);
  const paths = [...new Set(targets.map((target) => target.path))];
  if (paths.length !== 1) return null;
  const info = await lstat(paths[0]).catch((error) => (
    error?.code === 'ENOENT' ? null : Promise.reject(error)
  ));
  return info == null ? 'create_file' : 'edit_file';
}

function operationAllowed(tools, operation) {
  if (!operation || tools?.mode === 'none') return false;
  if (tools?.mode === 'all') return true;
  return tools?.mode === 'allowlist' && tools.names?.includes(operation);
}

/** Build one operation-and-target identity used unchanged by announce, permission, and completion. */
async function acpToolDecision(request, toolCall, { expectedOperation = null } = {}) {
  const operation = await canonicalAcpOperation(toolCall, request.cwd, expectedOperation);
  if (!operation || !operationAllowed(request.tools, operation)) {
    return { allowed: false, operation, identity: null, targets: [] };
  }
  const providerOperation = acpProviderOperation(toolCall);
  let targets = acpToolTargets(toolCall, request.cwd, providerOperation);
  // Legacy/unscoped ACP read notifications occasionally omit a location. They remain bounded by
  // cwd and the normalized read operation. A path-v1 request never accepts an undisclosed target.
  if (!targets.length && !request.tools?.scope && operation === 'read_file') {
    targets = [{ path: request.cwd, access: 'read' }];
  }
  if (!targets.length || targets.some((target) => !target.path)) {
    return { allowed: false, operation, identity: null, targets };
  }
  const scope = request.tools?.scope;
  if (scope && scope.protocol !== 'path-v1') {
    return { allowed: false, operation, identity: null, targets };
  }
  const identities = [];
  for (const target of targets) {
    const canonical = await canonicalToolTarget(target.path);
    if (!canonical) return { allowed: false, operation, identity: null, targets };
    if (scope) {
      const configuredRoots = target.access === 'write' ? scope.writeRoots : scope.readRoots;
      const admitted = (await Promise.all(
        configuredRoots.map((root) => canonicalToolTarget(root))
      )).filter(Boolean);
      if (!admitted.some((root) => inside(canonical, root))) {
        return { allowed: false, operation, identity: null, targets };
      }
    }
    identities.push(`${target.access}:${canonical}`);
  }
  return {
    allowed: true,
    operation,
    identity: `${operation}|${[...new Set(identities)].sort().join('|')}`,
    targets
  };
}

export async function acpPermissionOutcome(request, params) {
  const tools = request.tools;
  if (tools?.mode === 'none') return { outcome: 'cancelled' };
  const option = params.options?.find((entry) => entry.kind === 'allow_once');
  if (!option) return { outcome: 'cancelled' };
  const decision = await acpToolDecision(request, params.toolCall);
  return decision.allowed
    ? { outcome: 'selected', optionId: option.optionId }
    : { outcome: 'cancelled' };
}

function acpUsage(value) {
  if (!value || typeof value !== 'object') return { status: 'unavailable' };
  const observed = Object.fromEntries([
    ['totalTokens', value.totalTokens], ['inputTokens', value.inputTokens],
    ['outputTokens', value.outputTokens], ['reasoningTokens', value.thoughtTokens],
    ['cachedInputTokens', value.cachedReadTokens], ['cacheWriteInputTokens', value.cachedWriteTokens]
  ].filter(([, item]) => Number.isFinite(item) && item >= 0).map(([key, item]) => [key, Number(item)]));
  const core = ['totalTokens', 'inputTokens', 'outputTokens'];
  if (!Object.keys(observed).length) return { status: 'unavailable' };
  return {
    status: core.every((key) => observed[key] != null) ? 'exact' : 'partial',
    assurance: 'provider-reported',
    ...observed,
  };
}

function boundedToolName(value, fallback = 'unknown') {
  const normalized = String(value ?? '').trim().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 80);
  return normalized || fallback;
}

function serializedBytes(value) {
  if (value == null) return 0;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return 0; }
}

function truncationObserved(value, seen = new Set(), depth = 0) {
  if (value == null || depth > 8) return false;
  if (typeof value === 'string') return /(?:\btruncated\b|output limit reached|result limit reached)/i.test(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => truncationObserved(item, seen, depth + 1));
  return Object.entries(value).some(([key, item]) => (
    /truncat/i.test(key) && item !== false && item != null && item !== 0 && item !== 'false'
  ) || truncationObserved(item, seen, depth + 1));
}

function acpSessionModel(session) {
  const extensionModel = session?.models?.currentModelId;
  if (typeof extensionModel === 'string' && extensionModel.trim()) return extensionModel.trim();
  const option = session?.configOptions?.find((entry) => (
    entry?.category === 'model' || entry?.id === 'model'
  ));
  return typeof option?.currentValue === 'string' && option.currentValue.trim()
    ? option.currentValue.trim() : null;
}

async function acpTelemetryObservation(request) {
  const file = request.telemetry?.rawAbsolute;
  if (!file) return { resolvedModels: [], modelAssurance: 'unavailable', turns: null };
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size < 1) {
    return { resolvedModels: [], modelAssurance: 'unavailable', turns: null };
  }
  try {
    const { parseCopilotTelemetry } = await import('../telemetry.mjs');
    const parsed = parseCopilotTelemetry(await readFile(file, 'utf8'));
    const resolvedModels = [...new Set(parsed.spans
      .filter((span) => span.resolvedModel && span.resolvedModelAssurance === 'provider-reported')
      .map((span) => span.resolvedModel))];
    return {
      resolvedModels,
      modelAssurance: resolvedModels.length ? 'provider-reported' : 'unavailable',
      turns: parsed.spans.length || null
    };
  } catch {
    return { resolvedModels: [], modelAssurance: 'unavailable', turns: null };
  }
}

function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Copilot CLI 1.0.80 exposes one `edit` tool for both provider-independent `edit_file` and
 * `create_file`, but that tool opens the target before applying its patch. A new path therefore
 * fails with ENOENT even when the normalized SFlow policy explicitly authorized `create_file`.
 *
 * ACP streams the tool call (including its path) before executing it. Materialize only an empty
 * regular target, only for a reviewed create policy, and only below the kernel's canonical allowed
 * roots. Copilot still supplies every content byte through its ordinary edit tool and all caller
 * post-run isolation and validation remains in force.
 */
async function precreateAcpEditTarget(request, decision) {
  if (decision.operation !== 'create_file') return true;
  const requested = decision.targets;
  if (!requested.length || requested.some((target) => target.access !== 'write' || !target.path)) return false;
  const requestedPaths = [...new Set(requested.map((target) => target.path))];
  if (requestedPaths.length !== 1) return false;
  const [candidate] = requestedPaths;
  const basename = path.basename(candidate);
  if (!basename || basename === '.' || basename === path.parse(candidate).root) return false;

  // Resolve the closest existing ancestor first. This handles macOS /var -> /private/var without
  // trusting a lexical prefix, and prevents mkdir from following an unreviewed symlink outside an
  // admitted root.
  let ancestor = path.dirname(candidate);
  const missing = [];
  while (!await lstat(ancestor).catch(() => null)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const canonicalAncestor = await realpath(ancestor).catch(() => null);
  if (!canonicalAncestor) return false;
  const canonicalRoots = (await Promise.all(
    (request.tools?.scope?.writeRoots ?? request.allowedRoots)
      .map((root) => realpath(root).catch(() => canonicalToolTarget(root)))
  )).filter(Boolean);
  const canonicalCandidate = path.join(canonicalAncestor, ...missing, basename);
  const allowedRoot = canonicalRoots.find((root) => inside(canonicalCandidate, root));
  if (!allowedRoot) return false;

  let parent = canonicalAncestor;
  for (const segment of missing) {
    const next = path.join(parent, segment);
    if (!inside(next, allowedRoot) && !inside(allowedRoot, next)) return false;
    await mkdir(next, { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    const info = await lstat(next).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
    parent = next;
  }
  const target = path.join(parent, basename);
  if (!inside(target, allowedRoot)) return false;
  const existing = await lstat(target).catch(() => null);
  if (existing) return false;
  const handle = await open(target, 'wx', 0o600).catch((error) => {
    if (error?.code === 'EEXIST') return null;
    throw error;
  });
  if (!handle) return false;
  await handle.close();
  return true;
}

function providerRuntime(overrides = {}) {
  return Object.freeze({
    platform: overrides.platform ?? process.platform,
    environment: overrides.environment ?? process.env,
    spawnImpl: overrides.spawnImpl ?? spawn,
    spawnSyncImpl: overrides.spawnSyncImpl ?? spawnSync,
    resolvedExecutable: overrides.resolvedExecutable ?? null
  });
}

function providerIdentity(request, runtimeOverrides = {}) {
  const runtime = providerRuntime(runtimeOverrides);
  const configured = request.providerConfig ?? {};
  const executable = configured.executable ?? 'copilot';
  if (typeof executable !== 'string' || !executable.trim() || /[\r\n\0]/.test(executable)) {
    throw new SingularityFlowError('Model provider executable must be a non-empty command or path.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (configured.arguments != null && (!Array.isArray(configured.arguments) || configured.arguments.some((item) => typeof item !== 'string'))) {
    throw new SingularityFlowError('Model provider arguments must be an array of strings.', { code: 'MODEL_REQUEST_INVALID' });
  }
  const conflict = (configured.arguments ?? []).map(reservedOption).find(Boolean);
  if (conflict) {
    throw new SingularityFlowError(`Model provider arguments cannot override adapter-owned option '${conflict}'.`, {
      code: 'MODEL_REQUEST_INVALID', details: { option: conflict }
    });
  }
  const launch = resolveModelProviderLaunch(executable, {
    platform: runtime.platform,
    environment: runtime.environment,
    spawnSyncImpl: runtime.spawnSyncImpl,
    resolvedExecutable: runtime.resolvedExecutable
  });
  const command = launch.target ?? executable;
  const configuredExecutable = configured.executable != null && executable !== 'copilot' && executable !== 'copilot.cmd';
  const providerLabel = request.provider === 'copilot-cli'
    ? (configuredExecutable ? `Model provider '${command}'` : 'Copilot CLI')
    : `Model provider '${request.provider}'`;
  return { configured, command, launch, providerLabel, runtime };
}

async function verifiedStagedPrompt(request, transport) {
  if (request.prompt?.text != null || !request.prompt?.staged || !request.prompt?.file
    || request.prompt?.encoding !== 'utf-8' || !Number.isSafeInteger(request.prompt?.bytes)
    || !/^[a-f0-9]{64}$/.test(String(request.prompt?.sha256 ?? ''))) {
    throw new SingularityFlowError(`Copilot ${transport} transport requires a trusted staged prompt.`, {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  const promptInfo = await lstat(request.prompt.file).catch(() => null);
  if (!promptInfo?.isFile() || promptInfo.isSymbolicLink()) {
    throw new SingularityFlowError(`Copilot ${transport} transport requires a regular staged prompt file.`, {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  const bytes = await readFile(request.prompt.file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== request.prompt.bytes || digest !== request.prompt.sha256) {
    throw new SingularityFlowError('The staged model prompt changed after admission.', {
      code: 'MODEL_REQUEST_INVALID', details: { transport }
    });
  }
  return bytes.toString('utf8');
}

function terminateAcpProcess(child, force = false, runtimeOverrides = {}) {
  const runtime = providerRuntime(runtimeOverrides);
  if (!child.pid || child.exitCode != null || child.signalCode != null) return true;
  if (runtime.platform === 'win32') {
    return tryWindowsTaskkill(child.pid, {
      force, environment: runtime.environment, spawnSyncCommand: runtime.spawnSyncImpl,
      timeoutMs: 5_000
    });
  }
  try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); return true; }
  catch { return child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
}

async function invokeCopilotAcp(request, runtimeOverrides = {}) {
  const { configured, launch, providerLabel, runtime } = providerIdentity(request, runtimeOverrides);
  if (request.promptTransport !== 'acp-stdio') {
    throw new SingularityFlowError('Copilot ACP adapter received the wrong prompt transport.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (request.signal?.aborted) {
    throw new SingularityFlowError('Model invocation was cancelled.', { code: 'MODEL_CANCELLED' });
  }
  const promptText = await verifiedStagedPrompt(request, 'ACP stdio');
  const args = [
    ...(configured.arguments ?? []), '--acp', ...ACP_BOUNDARY_OPTIONS,
    ...copilotAllowedRootArguments(request)
  ];
  args.push(...copilotToolArguments(request.tools));
  // `auto` is an explicit provider decision, not the contributor's last interactive selection.
  // Passing it makes each isolated ACP session ask Copilot to choose the appropriate model.
  const requestedModel = request.model ?? configured.model ?? 'auto';
  args.push('--model', requestedModel);
  args.push(...copilotAiCreditArguments(request.limits));
  const outputLimit = request.limits.outputBytes;
  const protocolLimit = Math.max(1024 * 1024, Math.min(64 * 1024 * 1024, outputLimit * 16));
  if (request.telemetry) await recordTelemetryLaunch(request.telemetry, { state: 'started' }).catch(() => {});

  const child = runtime.spawnImpl(launch.command, launch.arguments(args), {
    cwd: request.cwd,
    env: providerEnvironment(request.env, request.telemetry),
    ...launch.spawnOptions,
    detached: runtime.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let expectedExit = false;
  let stderr = ''; let stderrBytes = 0; let output = ''; let outputBytes = 0;
  let protocolBytes = 0; let protocolVersion = null; let sessionId = null;
  let providerSelectedModel = null; let promptResult = null;
  const stderrDecoder = new StringDecoder('utf8');
  const protocolDecoder = new StringDecoder('utf8');
  let protocolPending = '';
  let boundaryReject;
  let boundaryStopped = false;
  const boundaryFailure = new Promise((resolve, reject) => { boundaryReject = reject; });
  child.stderr?.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= outputLimit) stderr += stderrDecoder.write(chunk);
  });
  let closeObserved = false;
  const exit = new Promise((resolve) => child.once('close', (status, signal) => {
    closeObserved = true;
    resolve({ status, signal });
  }));
  const processFailure = new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new SingularityFlowError(`Unable to start ${providerLabel} (${error.code ?? 'unknown startup error'}).`, {
      code: modelProviderStartErrorCode(error.code),
      details: { nativeCode: error.code ?? null, transport: 'acp-stdio', promptBytes: request.prompt.bytes }
    })));
    child.once('close', (status, signal) => {
      if (expectedExit) return resolve();
      stderr += stderrDecoder.end();
      reject(status !== 0
        ? providerExitError(providerLabel, status, signal, stderr)
        : new SingularityFlowError(`${providerLabel} ACP server stopped before completing the prompt.`, {
          code: 'MODEL_PROVIDER_PROTOCOL_FAILED', details: { status, signal, transport: 'acp-stdio' }
        }));
    });
  });
  const guardedInput = Readable.toWeb(child.stdout).pipeThrough(new TransformStream({
    transform(chunk, controller) {
      protocolBytes += chunk.byteLength;
      if (protocolBytes > protocolLimit) {
        const error = new SingularityFlowError(`${providerLabel} ACP protocol stream exceeded ${protocolLimit} bytes.`, {
          code: 'MODEL_OUTPUT_LIMIT'
        });
        boundaryReject(error);
        throw error;
      }
      protocolPending += protocolDecoder.write(Buffer.from(chunk));
      const lines = protocolPending.split('\n');
      protocolPending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { JSON.parse(line); }
        catch {
          const error = new SingularityFlowError(`${providerLabel} emitted malformed ACP NDJSON.`, {
            code: 'MODEL_PROVIDER_PROTOCOL_FAILED'
          });
          boundaryReject(error);
          throw error;
        }
      }
      controller.enqueue(chunk);
    },
    flush() {
      protocolPending += protocolDecoder.end();
      if (!protocolPending.trim()) return;
      try { JSON.parse(protocolPending); }
      catch {
        const error = new SingularityFlowError(`${providerLabel} ended with malformed ACP NDJSON.`, {
          code: 'MODEL_PROVIDER_PROTOCOL_FAILED'
        });
        boundaryReject(error);
        throw error;
      }
    }
  }));
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), guardedInput);
  const toolCalls = new Map();
  const activeToolCalls = new Set();
  const toolPermissions = new Map();
  let sessionUpdateTail = Promise.resolve();
  const enqueueSessionUpdate = (work) => {
    const current = sessionUpdateTail.then(work, work);
    // Keep the serialization chain live after an individual update failure. The invocation's
    // boundary promise carries the actual failure to the caller.
    sessionUpdateTail = current.catch(() => {});
    return current;
  };
  const drainSessionUpdates = async () => {
    // The ACP SDK resolves the prompt response independently from async notification callbacks. A
    // response can therefore become visible while a preceding tool completion is only queued for
    // dispatch. Require two stable event-loop turns so no operation/target change can arrive just
    // after the invocation has been accepted.
    let stableTurns = 0;
    while (stableTurns < 2) {
      const observedTail = sessionUpdateTail;
      await observedTail;
      await new Promise((resolve) => setImmediate(resolve));
      stableTurns = observedTail === sessionUpdateTail ? stableTurns + 1 : 0;
    }
  };
  let toolRounds = 0;
  const maximumToolCalls = request.limits.maxToolCalls ?? 64;
  const toolCallsAreAutomatic = maximumToolCalls === 'auto';
  // `auto` delegates conversation completion to the ACP agent. It is intentionally not the
  // provider-wide default: callers must opt in for operations, such as world-model discovery and
  // synthesis, whose number of tool rounds depends on repository size and the output graph. Independent
  // timeout, output, token, tool-call, tool-result, and cancellation guards remain in force.
  const maximumTurns = request.limits.maxTurns ?? 16;
  const turnsAreAutomatic = maximumTurns === 'auto';
  const maximumToolResultBytes = request.limits.maxToolResultBytes ?? 1024 * 1024;
  const toolObservation = (exactTurns = null) => {
    const calls = [...toolCalls.values()].sort((a, b) => a.sequence - b.sequence).map((entry) => ({
      sequence: entry.sequence,
      name: boundedToolName(entry.name, boundedToolName(entry.kind)),
      kind: boundedToolName(entry.kind),
      operation: boundedToolName(entry.operation),
      status: ['pending', 'in_progress', 'completed', 'failed'].includes(entry.status)
        ? entry.status : 'unknown',
      outputBytes: Number.isSafeInteger(entry.outputBytes) ? entry.outputBytes : 0,
      truncated: entry.truncated === true,
      preparationFailed: entry.preparationFailed === true
    }));
    return {
      status: 'exact', calls,
      totalCalls: calls.length,
      failedCalls: calls.filter((entry) => entry.status === 'failed' || entry.preparationFailed).length,
      preparationFailedCalls: calls.filter((entry) => entry.preparationFailed).length,
      incompleteCalls: calls.filter((entry) => ['pending', 'in_progress', 'unknown'].includes(entry.status)).length,
      truncatedCalls: calls.filter((entry) => entry.truncated).length,
      turns: exactTurns ?? Math.max(1, toolRounds + 1),
      turnAssurance: exactTurns == null ? 'protocol-derived' : 'provider-telemetry'
    };
  };
  const modelSelectionReceipt = (resolvedModels = [], assurance = 'unavailable') => ({
    policy: requestedModel === 'auto' ? 'provider-auto' : 'sflow-selected',
    requestedModel,
    providerSelectedModel,
    resolvedModels,
    assurance: assurance !== 'unavailable'
      ? assurance : providerSelectedModel && providerSelectedModel !== 'auto'
        ? 'acp-session' : 'unavailable'
  });
  const boundaryError = (message, code, details = {}) => {
    const error = new SingularityFlowError(message, {
      code, details: {
        ...details,
        modelSelection: modelSelectionReceipt(),
        toolObservation: toolObservation()
      }
    });
    if (!boundaryStopped) {
      boundaryStopped = true;
      boundaryReject(error);
    }
    return error;
  };
  const connection = new acp.ClientSideConnection(() => ({
    async requestPermission(params) {
      // An announce notification may precede the permission request. Finish its canonical-path and
      // operation classification before deciding the same toolCallId so either ACP ordering has one
      // identical authorization boundary.
      await drainSessionUpdates();
      const option = params.options?.find((entry) => entry.kind === 'allow_once');
      const decision = option
        ? await acpToolDecision(request, params.toolCall)
        : { allowed: false, operation: null, identity: null, targets: [] };
      const toolCallId = params.toolCall?.toolCallId;
      if (decision.allowed && option && toolCallId) {
        const announced = toolCalls.get(toolCallId);
        if (announced && (announced.operation !== decision.operation
            || announced.identity !== decision.identity)) {
          boundaryError(
            `${providerLabel} changed an ACP tool's operation or targets before permission.`,
            request.tools?.scope ? 'MODEL_TOOL_SCOPE_UNENFORCED' : 'MODEL_TOOL_OPERATION_UNENFORCED'
          );
          return { outcome: { outcome: 'cancelled' } };
        }
        try {
          if (!await precreateAcpEditTarget(request, decision)) {
            boundaryError(
              `${providerLabel} could not prove an empty ACP create target at permission time.`,
              'MODEL_CREATE_TARGET_FAILED'
            );
            return { outcome: { outcome: 'cancelled' } };
          }
        } catch {
          boundaryError(
            `${providerLabel} could not safely materialize an authorized ACP create target.`,
            'MODEL_CREATE_TARGET_FAILED'
          );
          return { outcome: { outcome: 'cancelled' } };
        }
        toolPermissions.set(toolCallId, decision);
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    },
    async sessionUpdate(params) {
      return enqueueSessionUpdate(async () => {
        if (boundaryStopped) return;
        const update = params.update;
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const isNew = !toolCalls.has(update.toolCallId);
        if (isNew && !toolCallsAreAutomatic && toolCalls.size >= maximumToolCalls) {
          boundaryError(
            `${providerLabel} exceeded the ${maximumToolCalls}-call ACP tool budget.`,
            'MODEL_TOOL_CALL_LIMIT', { maximumToolCalls }
          );
          return;
        }
        if (isNew && activeToolCalls.size === 0) {
          toolRounds += 1;
          if (!turnsAreAutomatic && toolRounds + 1 > maximumTurns) {
            boundaryError(
              `${providerLabel} exceeded the ${maximumTurns}-turn ACP budget.`,
              'MODEL_TURN_LIMIT', { maximumTurns }
            );
            return;
          }
        }
        const prior = toolCalls.get(update.toolCallId) ?? {
          sequence: toolCalls.size + 1, status: 'pending', outputBytes: 0,
          truncated: false, preparationFailed: false
        };
        const toolOutput = update.rawOutput ?? update.content;
        const current = {
          ...prior,
          ...(update.name != null ? { name: update.name } : {}),
          ...(update.kind != null ? { kind: update.kind } : {}),
          ...(update.status != null ? { status: update.status } : {}),
          ...(update.rawInput != null ? { rawInput: update.rawInput } : {}),
          ...(update.locations != null ? { locations: update.locations } : {}),
          ...(toolOutput != null ? {
            outputBytes: serializedBytes(toolOutput),
            truncated: prior.truncated || truncationObserved(toolOutput)
          } : {})
        };
        const permission = toolPermissions.get(update.toolCallId) ?? null;
        const decision = await acpToolDecision(request, current, {
          expectedOperation: permission?.operation ?? prior.operation ?? null
        });
        current.operation = decision.operation;
        current.identity = decision.identity;
        toolCalls.set(update.toolCallId, current);
        const terminal = ['completed', 'failed'].includes(current.status) || toolOutput != null;
        const changedFromAnnouncement = prior.operation && (
          prior.operation !== decision.operation || prior.identity !== decision.identity
        );
        const changedFromPermission = permission && (
          permission.operation !== decision.operation || permission.identity !== decision.identity
        );
        const permissionRequired = ACP_MUTATING_OPERATIONS.has(decision.operation);
        if (!decision.allowed || !decision.identity || changedFromAnnouncement
            || changedFromPermission || (terminal && permissionRequired && !permission)) {
          boundaryError(
            `${providerLabel} attempted an ACP tool without one exact operation-and-target permission.`,
            request.tools?.scope ? 'MODEL_TOOL_SCOPE_UNENFORCED' : 'MODEL_TOOL_OPERATION_UNENFORCED',
            {
              operation: decision.operation,
              operationAllowed: decision.allowed,
              changedFromAnnouncement: Boolean(changedFromAnnouncement),
              changedFromPermission: Boolean(changedFromPermission),
              permissionPresent: Boolean(permission),
              providerTool: boundedToolName(current.name),
              providerKind: boundedToolName(current.kind)
            }
          );
          return;
        }
        if (!['completed', 'failed'].includes(current.status)) activeToolCalls.add(update.toolCallId);
        else activeToolCalls.delete(update.toolCallId);
        if (current.outputBytes > maximumToolResultBytes) {
          boundaryError(
            `${providerLabel} ACP tool result exceeded ${maximumToolResultBytes} bytes.`,
            'MODEL_TOOL_RESULT_LIMIT', { maximumToolResultBytes }
          );
          return;
        }
      }
        if (update.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return;
        const chunkBytes = Buffer.byteLength(update.content.text, 'utf8');
        outputBytes += chunkBytes;
        if (outputBytes > outputLimit) {
          boundaryError(
            `${providerLabel} output exceeded ${outputLimit} bytes.`,
            'MODEL_OUTPUT_LIMIT', { outputLimit }
          );
          return;
        }
        output += update.content.text;
      });
    }
  }), stream);
  let timer;
  let abortListener;
  let primaryFailure = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new SingularityFlowError(`${providerLabel} invocation exceeded ${request.limits.timeoutMs}ms.`, {
      code: 'MODEL_TIMEOUT'
    })), request.limits.timeoutMs);
  });
  const cancellation = new Promise((resolve, reject) => {
    abortListener = () => reject(new SingularityFlowError('Model invocation was cancelled.', { code: 'MODEL_CANCELLED' }));
    request.signal?.addEventListener('abort', abortListener, { once: true });
  });

  try {
    const operation = (async () => {
      const initialized = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'singularity-flow', version: VERSION }
      });
      if (!Number.isInteger(initialized.protocolVersion)
        || initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new SingularityFlowError(`Copilot ACP negotiated unsupported protocol version '${initialized.protocolVersion}'.`, {
          code: 'MODEL_PROVIDER_PROTOCOL_UNSUPPORTED'
        });
      }
      protocolVersion = initialized.protocolVersion;
      const session = await connection.newSession({ cwd: request.cwd, mcpServers: [] });
      sessionId = session.sessionId;
      providerSelectedModel = acpSessionModel(session);
      if (requestedModel !== 'auto' && providerSelectedModel && providerSelectedModel !== requestedModel) {
        const modelSelection = modelSelectionReceipt();
        throw new SingularityFlowError(
          `${providerLabel} selected '${providerSelectedModel}' instead of required model '${requestedModel}'.`,
          {
            code: 'MODEL_NOT_AVAILABLE', details: {
              requestedModel, providerSelectedModel, modelSelection, transport: 'acp-stdio'
            }
          }
        );
      }
      const result = await connection.prompt({
        sessionId, prompt: [{ type: 'text', text: promptText }]
      });
      // ACP notifications preceding the prompt result can contain asynchronous canonical-path
      // checks. Do not accept the result until every preceding update has crossed that boundary.
      await drainSessionUpdates();
      if (result.stopReason !== 'end_turn') {
        throw new SingularityFlowError(`Copilot ACP stopped with reason '${result.stopReason}'.`, {
          code: result.stopReason === 'cancelled' ? 'MODEL_CANCELLED'
            : ['max_tokens', 'max_turn_requests'].includes(result.stopReason)
              ? 'MODEL_TOKEN_BUDGET_EXCEEDED' : 'MODEL_PROVIDER_FAILED',
          details: {
            stopReason: result.stopReason,
            transport: 'acp-stdio',
            promptProtocolVersion: protocolVersion,
            usage: acpUsage(result.usage),
            toolObservation: toolObservation()
          }
        });
      }
      return result;
    })();
    promptResult = await Promise.race([operation, processFailure, boundaryFailure, timeout, cancellation]);
    if (stderrBytes > outputLimit) {
      throw new SingularityFlowError(`${providerLabel} diagnostics exceeded ${outputLimit} bytes.`, { code: 'MODEL_OUTPUT_LIMIT' });
    }
    if (unavailableModelDiagnostic(stderr) && requestedModel !== 'auto') {
      throw providerExitError(providerLabel, 0, null, stderr);
    }
  } catch (error) {
    if (sessionId) await connection.cancel({ sessionId }).catch(() => {});
    if (error instanceof SingularityFlowError) primaryFailure = error;
    else {
      const diagnostic = boundedDiagnostic(stderr);
      primaryFailure = new SingularityFlowError(
        diagnostic ? `${providerLabel} ACP prompt transport failed: ${diagnostic}` : `${providerLabel} ACP prompt transport failed.`,
        { code: 'MODEL_PROVIDER_PROTOCOL_FAILED', details: { transport: 'acp-stdio', diagnostic: diagnostic || null } }
      );
    }
    throw primaryFailure;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abortListener);
    expectedExit = true;
    child.stdin?.end();
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS))]);
    const softSignalled = terminateAcpProcess(child, false, runtime);
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS))]);
    const forceSignalled = terminateAcpProcess(child, true, runtime);
    const ended = await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve({ status: null, signal: 'SIGKILL' }), 1000))]);
    // Flush a trailing split UTF-8 diagnostic in the ordinary successful-exit path too. The
    // unexpected-exit handler already does this; StringDecoder.end() is safe to call again.
    stderr += stderrDecoder.end();
    if (request.telemetry) await recordTelemetryLaunch(request.telemetry, {
      state: 'finished', exitCode: ended.status, signal: ended.signal
    }).catch(() => {});
    if (!closeObserved) {
      const cleanupFailure = new SingularityFlowError(
        `${providerLabel} ACP process did not terminate after bounded graceful and forced cleanup.`,
        {
          code: 'MODEL_PROVIDER_TERMINATION_FAILED',
          details: {
            transport: 'acp-stdio', platform: runtime.platform,
            softSignalled, forceSignalled, pid: child.pid ?? null
          }
        }
      );
      // Cancellation remains cancellation to callers, while recording that process quiescence was
      // not proven. A successful or otherwise failed invocation cannot silently return with a live
      // provider child.
      if (primaryFailure?.code === 'MODEL_CANCELLED') {
        primaryFailure.details = {
          ...(primaryFailure.details ?? {}), cleanup: cleanupFailure.details,
          cleanupCode: cleanupFailure.code
        };
      } else {
        throw cleanupFailure;
      }
    }
  }

  const telemetry = await acpTelemetryObservation(request);
  const observation = toolObservation(telemetry.turns);
  const modelSelection = modelSelectionReceipt(
    telemetry.resolvedModels, telemetry.modelAssurance
  );
  const usage = acpUsage(promptResult?.usage);
  const completedEvidence = {
    modelSelection,
    toolObservation: observation,
    usage,
    promptProtocolVersion: protocolVersion,
    transport: 'acp-stdio'
  };
  if (requestedModel !== 'auto' && telemetry.resolvedModels.length
      && telemetry.resolvedModels.some((model) => model !== requestedModel)) {
    throw new SingularityFlowError(
      `${providerLabel} executed a model different from required model '${requestedModel}'.`,
      { code: 'MODEL_SELECTION_MISMATCH', details: completedEvidence }
    );
  }
  const tokensAreAutomatic = request.limits.maxTotalTokens === 'auto';
  if (!tokensAreAutomatic && Number.isFinite(usage.totalTokens)
      && usage.totalTokens > request.limits.maxTotalTokens) {
    throw new SingularityFlowError(
      `${providerLabel} exceeded the ${request.limits.maxTotalTokens}-token invocation budget.`,
      {
        code: 'MODEL_TOKEN_BUDGET_EXCEEDED',
        details: {
          ...completedEvidence,
          maximumTotalTokens: request.limits.maxTotalTokens,
          observedTotalTokens: usage.totalTokens
        }
      }
    );
  }
  if (!turnsAreAutomatic && observation.turns > maximumTurns) {
    throw new SingularityFlowError(
      `${providerLabel} exceeded the ${maximumTurns}-turn ACP budget.`,
      { code: 'MODEL_TURN_LIMIT', details: { ...completedEvidence, maximumTurns } }
    );
  }
  // An unfinished call means the provider stopped before its tool protocol quiesced. That is never
  // a usable completion, even for callers that deliberately tolerate recovered exploratory
  // failures. `requireSuccessful: false` therefore relaxes only terminal failed calls.
  if (observation.incompleteCalls) {
    throw new SingularityFlowError(
      `${providerLabel} completed with incomplete ACP tool calls.`,
      { code: 'MODEL_TOOL_EXECUTION_INCOMPLETE', details: completedEvidence }
    );
  }
  if (request.tools.requireSuccessful && observation.failedCalls) {
    throw new SingularityFlowError(
      `${providerLabel} completed with failed ACP tool calls.`,
      { code: 'MODEL_TOOL_EXECUTION_FAILED', details: completedEvidence }
    );
  }
  if (request.tools.rejectTruncated && observation.truncatedCalls) {
    throw new SingularityFlowError(
      `${providerLabel} completed after one or more ACP tool results were truncated.`,
      { code: 'MODEL_TOOL_RESULT_TRUNCATED', details: completedEvidence }
    );
  }
  const normalizedOutput = output.trim();
  return {
    output: normalizedOutput, diagnostics: stderr.trim(), status: 0, signal: null,
    outputBytes: Buffer.byteLength(normalizedOutput, 'utf8'), streamedOutputBytes: outputBytes,
    usage, requestedModel,
    model: telemetry.resolvedModels.length === 1
      ? telemetry.resolvedModels[0] : providerSelectedModel ?? requestedModel,
    modelSelection, toolObservation: observation,
    promptTransport: 'acp-stdio', promptProtocolVersion: protocolVersion
  };
}

async function invokeCopilotAttachment(request, runtimeOverrides = {}) {
  if (request.tools?.scope && request.tools.mode !== 'none') {
    throw new SingularityFlowError(
      'Copilot attachment transport cannot enforce path-scoped tools before filesystem effects. Use ACP stdio.',
      { code: 'MODEL_TOOL_SCOPE_UNSUPPORTED', details: { transport: 'attachment' } }
    );
  }
  const configured = request.providerConfig ?? {};
  const executable = configured.executable ?? 'copilot';
  if (typeof executable !== 'string' || !executable.trim() || /[\r\n\0]/.test(executable)) {
    throw new SingularityFlowError('Model provider executable must be a non-empty command or path.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (configured.arguments != null && (!Array.isArray(configured.arguments) || configured.arguments.some((item) => typeof item !== 'string'))) {
    throw new SingularityFlowError('Model provider arguments must be an array of strings.', { code: 'MODEL_REQUEST_INVALID' });
  }
  const conflict = (configured.arguments ?? []).map(reservedOption).find(Boolean);
  if (conflict) {
    throw new SingularityFlowError(`Model provider arguments cannot override adapter-owned option '${conflict}'.`, {
      code: 'MODEL_REQUEST_INVALID', details: { option: conflict }
    });
  }
  if (request.promptTransport !== 'attachment' || request.prompt?.text != null || !request.prompt?.staged || !request.prompt?.file
    || request.prompt?.encoding !== 'utf-8' || !Number.isSafeInteger(request.prompt?.bytes)
    || !/^[a-f0-9]{64}$/.test(String(request.prompt?.sha256 ?? ''))) {
    throw new SingularityFlowError('Copilot attachment transport requires a trusted staged prompt.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  const promptInfo = await lstat(request.prompt.file).catch(() => null);
  if (!promptInfo?.isFile() || promptInfo.isSymbolicLink()) {
    throw new SingularityFlowError('Copilot attachment transport requires a regular staged prompt file.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  if (request.signal?.aborted) {
    throw new SingularityFlowError('Model invocation was cancelled.', { code: 'MODEL_CANCELLED' });
  }
  const runtime = providerRuntime(runtimeOverrides);
  const launch = resolveModelProviderLaunch(executable, {
    platform: runtime.platform,
    environment: runtime.environment,
    spawnSyncImpl: runtime.spawnSyncImpl,
    resolvedExecutable: runtime.resolvedExecutable
  });
  const command = launch.target ?? executable;
  /**
   * The label names what actually ran, not what the provider ID suggests.
   *
   * It used to say "Copilot CLI" whenever `provider === 'copilot-cli'`, regardless of the
   * executable the caller configured. So a timeout on a stand-in binary reported
   * `Copilot CLI invocation exceeded 10000ms`, which reads as a real Copilot call that never
   * happened — and sends whoever is holding the failure looking for network, auth and a machine
   * that has none of them. Naming the configured executable costs one line and is the difference
   * between a diagnosable failure and a misleading one.
   */
  const configuredExecutable = configured.executable != null && command !== 'copilot' && command !== 'copilot.cmd';
  const providerLabel = request.provider === 'copilot-cli'
    ? (configuredExecutable ? `Model provider '${command}'` : 'Copilot CLI')
    : `Model provider '${request.provider}'`;
  const args = [
    ...(configured.arguments ?? []), '-C', request.cwd,
    ...copilotAllowedRootArguments(request),
    '--attachment', request.prompt.file, '-p', COPILOT_ATTACHMENT_BOOTSTRAP_PROMPT
  ];
  args.push(...copilotToolArguments(request.tools));
  const requestedModel = request.model ?? configured.model ?? 'auto';
  args.push('--model', requestedModel);
  args.push(...copilotAiCreditArguments(request.limits));
  const timeoutMs = request.limits.timeoutMs;
  const outputLimit = request.limits.outputBytes;
  // Telemetry is observational. A missing/unwritable local receipt must never prevent the
  // governed model operation from running.
  if (request.telemetry) await recordTelemetryLaunch(request.telemetry, { state: 'started' }).catch(() => {});
  return new Promise((resolve, reject) => {
    const child = runtime.spawnImpl(launch.command, launch.arguments(args), {
      cwd: request.cwd,
      env: providerEnvironment(request.env, request.telemetry),
      ...launch.spawnOptions,
      detached: runtime.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = ''; let outputBytes = 0; let finished = false; let failure = null; let timer; let terminationTimer;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const onAbort = () => terminate(new SingularityFlowError('Model invocation was cancelled.', { code: 'MODEL_CANCELLED' }));
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    };
    const terminate = (error) => {
      if (finished || failure) return;
      failure = error;
      cleanup();
      let signalled = false;
      if (child.pid && runtime.platform === 'win32') {
        signalled = tryWindowsTaskkill(child.pid, {
          environment: runtime.environment, spawnSyncCommand: runtime.spawnSyncImpl,
          timeoutMs: 5_000
        });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); signalled = true; } catch { signalled = child.kill('SIGTERM'); }
      }
      if (!signalled) {
        finished = true;
        reject(error);
        return;
      }
      terminationTimer = setTimeout(() => {
        if (child.exitCode != null || child.signalCode != null) return;
        if (child.pid && runtime.platform === 'win32') {
          if (!tryWindowsTaskkill(child.pid, {
            force: true, environment: runtime.environment,
            spawnSyncCommand: runtime.spawnSyncImpl, timeoutMs: 5_000
          })) child.kill('SIGKILL');
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }, TERMINATION_GRACE_MS);
    };
    const append = (current, chunk, decoder) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) {
        terminate(new SingularityFlowError(`${providerLabel} output exceeded ${outputLimit} bytes.`, { code: 'MODEL_OUTPUT_LIMIT' }));
        return current;
      }
      return `${current}${decoder.write(chunk)}`;
    };
    timer = setTimeout(() => {
      terminate(new SingularityFlowError(`${providerLabel} invocation exceeded ${timeoutMs}ms.`, { code: 'MODEL_TIMEOUT' }));
    }, timeoutMs);
    if (request.signal?.aborted) return onAbort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk, stdoutDecoder); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk, stderrDecoder); });
    child.once('error', async (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (terminationTimer) clearTimeout(terminationTimer);
      if (request.telemetry) await recordTelemetryLaunch(request.telemetry, {
        state: 'finished', errorCode: modelProviderStartErrorCode(error.code)
      }).catch(() => {});
      const code = modelProviderStartErrorCode(error.code);
      reject(new SingularityFlowError(`Unable to start ${providerLabel} (${error.code ?? 'unknown startup error'}).`, {
        code, cause: error,
        details: { nativeCode: error.code ?? null, transport: 'attachment', promptBytes: request.prompt.bytes }
      }));
    });
    child.once('close', async (status, signal) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (terminationTimer) clearTimeout(terminationTimer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (request.telemetry) await recordTelemetryLaunch(request.telemetry, {
        state: 'finished', exitCode: status, signal
      }).catch(() => {});
      if (failure) return reject(failure);
      if (status !== 0) {
        return reject(providerExitError(providerLabel, status, signal, stderr));
      }
      // Some Copilot CLI releases report an unavailable/retired --model on stderr while exiting
      // zero. Treating that as a completed invocation caused parallel world-model discovery to fan
      // out seven empty workers and hid the only useful diagnostic.
      if (unavailableModelDiagnostic(stderr) && requestedModel !== 'auto') {
        return reject(providerExitError(providerLabel, status, signal, stderr));
      }
      const normalizedOutput = stdout.trim();
      resolve({
        output: normalizedOutput, diagnostics: stderr.trim(), status, signal,
        outputBytes: Buffer.byteLength(normalizedOutput, 'utf8'), streamedOutputBytes: outputBytes,
        usage: { status: 'unavailable' }, requestedModel, model: requestedModel,
        modelSelection: {
          policy: requestedModel === 'auto' ? 'provider-auto' : 'sflow-selected',
          requestedModel, providerSelectedModel: requestedModel,
          resolvedModels: [], assurance: 'unavailable'
        },
        toolObservation: { status: 'unavailable', calls: null },
        promptTransport: 'attachment', promptProtocolVersion: null
      });
    });
  });
}

export async function invokeCopilotCli(request, runtimeOverrides = {}) {
  if (request.promptTransport === 'acp-stdio') return invokeCopilotAcp(request, runtimeOverrides);
  if (request.promptTransport === 'attachment') return invokeCopilotAttachment(request, runtimeOverrides);
  throw new SingularityFlowError(`Copilot CLI does not support prompt transport '${request.promptTransport ?? 'unset'}'.`, {
    code: 'MODEL_REQUEST_INVALID'
  });
}
