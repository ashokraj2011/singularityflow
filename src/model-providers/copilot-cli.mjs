import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { SingularityFlowError } from '../util.mjs';

const DEFAULT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const SAFE_ENVIRONMENT = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'COMSPEC',
  'LANG', 'LC_ALL', 'TERM', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'GH_HOST', 'GITHUB_HOST', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
];

const SAFE_ENVIRONMENT_SET = new Set(SAFE_ENVIRONMENT);
const TEST_ENVIRONMENT = ['SFLOW_PARALLEL_TEST_LOG', 'SFLOW_MOCK_SKIP_PACKET_VIEW', 'SFLOW_MOCK_FAIL_SYNTHESIS',
  'SFLOW_MOCK_MANIFEST_RETRY_MARKER', 'SFLOW_MOCK_DIRECTORY_VIEW_RETRY_MARKER', 'SFLOW_MOCK_SHORT_SHA'];

function providerEnvironment(overrides = {}) {
  const forbidden = Object.keys(overrides).filter((key) => !SAFE_ENVIRONMENT_SET.has(key));
  if (forbidden.length) {
    throw new SingularityFlowError(`Model provider environment contains unsupported keys: ${forbidden.join(', ')}.`, {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  const inherited = process.env.NODE_ENV === 'test' ? [...SAFE_ENVIRONMENT, ...TEST_ENVIRONMENT] : SAFE_ENVIRONMENT;
  return Object.fromEntries([
    ...inherited.filter((key) => process.env[key] != null).map((key) => [key, process.env[key]]),
    ...Object.entries(overrides)
  ]);
}

export async function invokeCopilotCli(request) {
  const prompt = request.prompt?.text ?? await readFile(request.prompt.file, 'utf8');
  const configured = request.providerConfig ?? {};
  const executable = configured.executable ?? 'copilot';
  if (typeof executable !== 'string' || !executable.trim() || /[\r\n\0]/.test(executable)) {
    throw new SingularityFlowError('Model provider executable must be a non-empty command or path.', { code: 'MODEL_REQUEST_INVALID' });
  }
  if (configured.arguments != null && (!Array.isArray(configured.arguments) || configured.arguments.some((item) => typeof item !== 'string'))) {
    throw new SingularityFlowError('Model provider arguments must be an array of strings.', { code: 'MODEL_REQUEST_INVALID' });
  }
  const command = process.platform === 'win32' && executable === 'copilot' ? 'copilot.cmd' : executable;
  const providerLabel = request.provider === 'copilot-cli' ? 'Copilot CLI' : `Model provider '${request.provider}'`;
  const args = [...(configured.arguments ?? []), '-C', request.cwd, '-p', prompt];
  if (request.tools?.mode === 'all') args.push('--allow-all-tools');
  if (request.model ?? configured.model) args.push('--model', request.model ?? configured.model);
  const timeoutMs = request.limits.timeoutMs;
  const outputLimit = request.limits.outputBytes;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: request.cwd,
      env: providerEnvironment(request.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = ''; let outputBytes = 0; let settled = false; let timer;
    const onAbort = () => fail(new SingularityFlowError('Model invocation was cancelled.', { code: 'MODEL_CANCELLED' }));
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill('SIGTERM');
      reject(error);
    };
    const append = (current, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) {
        fail(new SingularityFlowError(`${providerLabel} output exceeded ${outputLimit} bytes.`, { code: 'MODEL_OUTPUT_LIMIT' }));
        return current;
      }
      return `${current}${chunk.toString('utf8')}`;
    };
    timer = setTimeout(() => {
      fail(new SingularityFlowError(`${providerLabel} invocation exceeded ${timeoutMs}ms.`, { code: 'MODEL_TIMEOUT' }));
    }, timeoutMs);
    if (request.signal?.aborted) return onAbort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => {
      fail(new SingularityFlowError(`Unable to start ${providerLabel}: ${error.message}`, { code: 'MODEL_PROVIDER_UNAVAILABLE', cause: error }));
    });
    child.once('close', (status, signal) => {
      if (settled) return; settled = true; cleanup();
      if (status !== 0) {
        return reject(new SingularityFlowError(`${providerLabel} exited with status ${status}${signal ? ` (${signal})` : ''}.`, {
          code: 'MODEL_EXIT_NONZERO', details: { status, signal }
        }));
      }
      resolve({ output: stdout.trim(), diagnostics: stderr.trim(), status, signal, outputBytes });
    });
  });
}
