import { spawnSync } from 'node:child_process';

import { commandExists, SingularityFlowError } from './util.mjs';
import { resolveModelProviderLaunch } from './model-provider-launch.mjs';

const TRANSPORTS = new Set(['auto', 'acp-stdio', 'attachment']);
const probeCache = new Map();

function blocked(executable, code, requested, reason) {
  return Object.freeze({
    state: 'blocked', code, capability: 'model-prompt-transport',
    requested, transport: null, protocolVersion: null, executable, reason
  });
}

/**
 * Network-free provider transport negotiation.
 *
 * `--attachment` existing in help is no longer proof that a UTF-8 text prompt can be attached:
 * current Copilot CLI releases reserve it for images/native documents. ACP is therefore the only
 * automatically selected text transport. A reviewed legacy provider can still opt in to the old
 * attachment contract explicitly.
 */
export function probeModelPromptTransport({
  type = 'copilot-cli',
  executable = 'copilot',
  promptTransport = 'auto',
  platform = process.platform,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  resolvedExecutable = null
} = {}) {
  if (type !== 'copilot-cli') return Object.freeze({
    state: 'not-applicable', code: null, capability: 'model-prompt-transport',
    requested: promptTransport, transport: null, protocolVersion: null, executable, reason: null
  });
  if (!TRANSPORTS.has(promptTransport)) {
    return blocked(executable, 'MODEL_REQUEST_INVALID', promptTransport, 'unsupported-transport');
  }
  const launch = resolveModelProviderLaunch(executable, {
    platform, environment, spawnSyncImpl, resolvedExecutable
  });
  const available = platform === 'win32' ? launch.available : commandExists(executable);
  if (!available) {
    return blocked(executable, 'MODEL_PROVIDER_UNAVAILABLE', promptTransport, 'executable-unavailable');
  }
  // Explicit attachment is a compatibility assertion made by the provider owner. Do not pretend
  // a generic help flag proves a particular file type, and do not make an otherwise compatible
  // custom executable implement a help mode solely for this opt-in path.
  if (promptTransport === 'attachment') return Object.freeze({
    state: 'ready', code: null, capability: 'model-prompt-transport', requested: promptTransport,
    transport: 'attachment', protocolVersion: null, executable, reason: 'explicit-legacy-opt-in'
  });
  // A forced ACP transport is also an explicit provider contract. The handshake still proves the
  // protocol before prompt delivery, which is stronger evidence than help text and supports
  // reviewed corporate wrappers whose help is intentionally minimal.
  if (promptTransport === 'acp-stdio') return Object.freeze({
    state: 'ready', code: null, capability: 'model-prompt-transport', requested: promptTransport,
    transport: 'acp-stdio', protocolVersion: null, executable, reason: 'explicit-acp-opt-in'
  });

  const key = `${type}\0${executable}\0${promptTransport}`;
  if (probeCache.has(key)) return probeCache.get(key);
  const probe = spawnSyncImpl(launch.command, launch.arguments(['--help']), {
    encoding: 'utf8', windowsHide: true, timeout: 5000, ...launch.spawnOptions
  });
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  const supported = probe.status === 0 && /(^|\s)--acp(?:\s|=|<|\[|$)/m.test(output);
  const result = supported
    ? Object.freeze({
      state: 'ready', code: null, capability: 'model-prompt-transport', requested: promptTransport,
      transport: 'acp-stdio', protocolVersion: null, executable, reason: 'acp-advertised'
    })
    : blocked(executable, 'MODEL_PROMPT_TRANSPORT_UNSUPPORTED', promptTransport, 'acp-not-advertised');
  probeCache.set(key, result);
  return result;
}

export function resolveModelPromptTransport(providerConfig = {}, type = 'copilot-cli') {
  const executable = providerConfig.executable ?? 'copilot';
  const result = probeModelPromptTransport({
    type, executable, promptTransport: providerConfig.promptTransport ?? 'auto'
  });
  if (result.state === 'ready' || result.state === 'not-applicable') return result;
  const message = result.code === 'MODEL_PROVIDER_UNAVAILABLE'
    ? `Model provider executable '${executable}' is unavailable.`
    : result.code === 'MODEL_REQUEST_INVALID'
      ? `Unsupported model prompt transport '${result.requested}'.`
      : 'Copilot CLI cannot accept private text prompts over ACP stdio. Upgrade Copilot CLI to a release that advertises --acp, or explicitly configure attachment only for a reviewed legacy-compatible provider.';
  throw new SingularityFlowError(message, {
    code: result.code, details: {
      capability: result.capability, requested: result.requested,
      executable: result.executable, reason: result.reason
    }
  });
}

/** @deprecated Use probeModelPromptTransport. Retained for callers compiled against 0.9.0. */
export function probePromptAttachmentCapability(options = {}) {
  return probeModelPromptTransport({ ...options, promptTransport: 'attachment' });
}

export function clearModelPromptTransportProbeCache() { probeCache.clear(); }
