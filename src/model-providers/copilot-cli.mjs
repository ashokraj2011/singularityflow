import * as acp from '@agentclientprotocol/sdk';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { TransformStream } from 'node:stream/web';
import { StringDecoder } from 'node:string_decoder';
import { isPreparedTelemetryLaunch, recordTelemetryLaunch } from '../telemetry-provision.mjs';
import { redactDiagnosticText } from '../git-remote-diagnostics.mjs';
import { SingularityFlowError } from '../util.mjs';
import { VERSION } from '../version.mjs';

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
  'SFLOW_MOCK_MANIFEST_RETRY_MARKER', 'SFLOW_MOCK_DIRECTORY_VIEW_RETRY_MARKER', 'SFLOW_MOCK_SHORT_SHA'];

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
  '--plugin-dir', '--acp', '--stdio'
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
  create_file: Object.freeze(['edit'])
});

function unique(values) { return [...new Set(values)]; }

export function copilotToolArguments(tools = { mode: 'none', names: [] }) {
  if (tools.mode === 'none') return ['--available-tools='];
  if (tools.mode === 'all') return ['--allow-all-tools'];
  const unsupported = tools.names.filter((name) => !COPILOT_TOOL_NAMES[name]);
  if (unsupported.length) {
    throw new SingularityFlowError(
      `Copilot CLI has no reviewed tool translation for: ${unsupported.join(', ')}.`,
      { code: 'MODEL_TOOL_UNSUPPORTED', details: { tools: unsupported } }
    );
  }
  const available = unique(tools.names.flatMap((name) => COPILOT_TOOL_NAMES[name]));
  const argumentsList = [`--available-tools=${available.join(',')}`];
  if (tools.names.some((name) => name === 'edit_file' || name === 'create_file')) {
    // Copilot's permission grammar authorizes file mutations as `write(...)`; `edit` is the
    // availability name, not a valid permission pattern. The request still has a bounded cwd,
    // allowed roots, an exact output contract, and the caller's post-run isolation check.
    argumentsList.push('--allow-tool=write');
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

function acpPermissionOutcome(tools, params) {
  if (tools?.mode === 'none') return { outcome: 'cancelled' };
  const option = params.options?.find((entry) => entry.kind === 'allow_once');
  if (!option) return { outcome: 'cancelled' };
  if (tools?.mode === 'all') return { outcome: 'selected', optionId: option.optionId };
  const allowed = new Set((tools?.names ?? []).flatMap((name) => COPILOT_TOOL_NAMES[name] ?? []));
  const byKind = Object.freeze({ read: 'view', search: 'grep', edit: 'edit', delete: 'edit', move: 'edit' });
  const requested = params.toolCall?.name ?? byKind[params.toolCall?.kind] ?? null;
  return requested && allowed.has(requested)
    ? { outcome: 'selected', optionId: option.optionId }
    : { outcome: 'cancelled' };
}

function acpUsage(value) {
  if (!value || !Number.isFinite(value.totalTokens)
    || !Number.isFinite(value.inputTokens) || !Number.isFinite(value.outputTokens)) {
    return { status: 'unavailable' };
  }
  return {
    status: 'exact', assurance: 'provider-reported',
    totalTokens: Number(value.totalTokens),
    inputTokens: Number(value.inputTokens),
    outputTokens: Number(value.outputTokens),
    ...(Number.isFinite(value.thoughtTokens) ? { reasoningTokens: Number(value.thoughtTokens) } : {}),
    ...(Number.isFinite(value.cachedReadTokens) ? { cachedInputTokens: Number(value.cachedReadTokens) } : {}),
    ...(Number.isFinite(value.cachedWriteTokens) ? { cacheWriteInputTokens: Number(value.cachedWriteTokens) } : {})
  };
}

function providerIdentity(request) {
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
  const command = process.platform === 'win32' && executable === 'copilot' ? 'copilot.cmd' : executable;
  const configuredExecutable = configured.executable != null && command !== 'copilot' && command !== 'copilot.cmd';
  const providerLabel = request.provider === 'copilot-cli'
    ? (configuredExecutable ? `Model provider '${command}'` : 'Copilot CLI')
    : `Model provider '${request.provider}'`;
  return { configured, command, providerLabel };
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

function terminateAcpProcess(child, force = false) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
      stdio: 'ignore', windowsHide: true, timeout: 5000
    });
    return;
  }
  try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
  catch { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
}

async function invokeCopilotAcp(request) {
  const { configured, command, providerLabel } = providerIdentity(request);
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
  if (request.model ?? configured.model) args.push('--model', request.model ?? configured.model);
  const outputLimit = request.limits.outputBytes;
  const protocolLimit = Math.max(1024 * 1024, Math.min(64 * 1024 * 1024, outputLimit * 16));
  if (request.telemetry) await recordTelemetryLaunch(request.telemetry, { state: 'started' }).catch(() => {});

  const child = spawn(command, args, {
    cwd: request.cwd,
    env: providerEnvironment(request.env, request.telemetry),
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let expectedExit = false;
  let stderr = ''; let stderrBytes = 0; let output = ''; let outputBytes = 0;
  let protocolBytes = 0; let protocolVersion = null; let sessionId = null;
  const stderrDecoder = new StringDecoder('utf8');
  const protocolDecoder = new StringDecoder('utf8');
  let protocolPending = '';
  let boundaryReject;
  const boundaryFailure = new Promise((resolve, reject) => { boundaryReject = reject; });
  child.stderr?.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= outputLimit) stderr += stderrDecoder.write(chunk);
  });
  const exit = new Promise((resolve) => child.once('close', (status, signal) => resolve({ status, signal })));
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
    }
  }));
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), guardedInput);
  const connection = new acp.ClientSideConnection(() => ({
    async requestPermission(params) { return { outcome: acpPermissionOutcome(request.tools, params) }; },
    async sessionUpdate(params) {
      const update = params.update;
      if (update.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return;
      const chunkBytes = Buffer.byteLength(update.content.text, 'utf8');
      outputBytes += chunkBytes;
      if (outputBytes > outputLimit) {
        const error = new SingularityFlowError(`${providerLabel} output exceeded ${outputLimit} bytes.`, {
          code: 'MODEL_OUTPUT_LIMIT'
        });
        boundaryReject(error);
        throw error;
      }
      output += update.content.text;
    }
  }), stream);
  let timer;
  let abortListener;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new SingularityFlowError(`${providerLabel} invocation exceeded ${request.limits.timeoutMs}ms.`, {
      code: 'MODEL_TIMEOUT'
    })), request.limits.timeoutMs);
    timer.unref?.();
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
      const result = await connection.prompt({
        sessionId, prompt: [{ type: 'text', text: promptText }]
      });
      if (result.stopReason !== 'end_turn') {
        throw new SingularityFlowError(`Copilot ACP stopped with reason '${result.stopReason}'.`, {
          code: result.stopReason === 'cancelled' ? 'MODEL_CANCELLED' : 'MODEL_PROVIDER_FAILED',
          details: { stopReason: result.stopReason, transport: 'acp-stdio' }
        });
      }
      return result;
    })();
    const result = await Promise.race([operation, processFailure, boundaryFailure, timeout, cancellation]);
    if (stderrBytes > outputLimit) {
      throw new SingularityFlowError(`${providerLabel} diagnostics exceeded ${outputLimit} bytes.`, { code: 'MODEL_OUTPUT_LIMIT' });
    }
    if (!output.trim() && unavailableModelDiagnostic(stderr)) {
      throw providerExitError(providerLabel, 0, null, stderr);
    }
    return {
      output: output.trim(), diagnostics: stderr.trim(), status: 0, signal: null,
      outputBytes, usage: acpUsage(result.usage),
      promptTransport: 'acp-stdio', promptProtocolVersion: protocolVersion
    };
  } catch (error) {
    if (sessionId) await connection.cancel({ sessionId }).catch(() => {});
    if (error instanceof SingularityFlowError) throw error;
    const diagnostic = boundedDiagnostic(stderr);
    throw new SingularityFlowError(
      diagnostic ? `${providerLabel} ACP prompt transport failed: ${diagnostic}` : `${providerLabel} ACP prompt transport failed.`,
      { code: 'MODEL_PROVIDER_PROTOCOL_FAILED', details: { transport: 'acp-stdio', diagnostic: diagnostic || null } }
    );
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abortListener);
    expectedExit = true;
    child.stdin?.end();
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS))]);
    terminateAcpProcess(child, false);
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS))]);
    terminateAcpProcess(child, true);
    const ended = await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve({ status: null, signal: 'SIGKILL' }), 1000))]);
    if (request.telemetry) await recordTelemetryLaunch(request.telemetry, {
      state: 'finished', exitCode: ended.status, signal: ended.signal
    }).catch(() => {});
  }
}

async function invokeCopilotAttachment(request) {
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
  const command = process.platform === 'win32' && executable === 'copilot' ? 'copilot.cmd' : executable;
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
  if (request.model ?? configured.model) args.push('--model', request.model ?? configured.model);
  const timeoutMs = request.limits.timeoutMs;
  const outputLimit = request.limits.outputBytes;
  // Telemetry is observational. A missing/unwritable local receipt must never prevent the
  // governed model operation from running.
  if (request.telemetry) await recordTelemetryLaunch(request.telemetry, { state: 'started' }).catch(() => {});
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: request.cwd,
      env: providerEnvironment(request.env, request.telemetry),
      shell: false,
      detached: process.platform !== 'win32',
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
      if (child.pid && process.platform === 'win32') {
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
        signalled = !killed.error && killed.status === 0;
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
        if (child.pid && process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }, TERMINATION_GRACE_MS);
      terminationTimer.unref?.();
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
      if (!stdout.trim() && unavailableModelDiagnostic(stderr)) {
        return reject(providerExitError(providerLabel, status, signal, stderr));
      }
      resolve({
        output: stdout.trim(), diagnostics: stderr.trim(), status, signal, outputBytes,
        promptTransport: 'attachment', promptProtocolVersion: null
      });
    });
  });
}

export async function invokeCopilotCli(request) {
  if (request.promptTransport === 'acp-stdio') return invokeCopilotAcp(request);
  if (request.promptTransport === 'attachment') return invokeCopilotAttachment(request);
  throw new SingularityFlowError(`Copilot CLI does not support prompt transport '${request.promptTransport ?? 'unset'}'.`, {
    code: 'MODEL_REQUEST_INVALID'
  });
}
