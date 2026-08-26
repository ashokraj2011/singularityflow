import { spawn, spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { isPreparedTelemetryLaunch, recordTelemetryLaunch } from '../telemetry-provision.mjs';
import { redactDiagnosticText } from '../git-remote-diagnostics.mjs';
import { SingularityFlowError } from '../util.mjs';

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
  '--allow-all-tools'
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

export async function invokeCopilotCli(request) {
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
      resolve({ output: stdout.trim(), diagnostics: stderr.trim(), status, signal, outputBytes });
    });
  });
}
