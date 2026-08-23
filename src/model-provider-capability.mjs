import { spawnSync } from 'node:child_process';

import { commandExists } from './util.mjs';

/** Network-free capability probe used by doctor before a model request can be attempted. */
export function probePromptAttachmentCapability({
  type = 'copilot-cli',
  executable = process.platform === 'win32' ? 'copilot.cmd' : 'copilot'
} = {}) {
  if (type !== 'copilot-cli') return Object.freeze({
    state: 'not-applicable', code: null, capability: 'prompt-attachment', executable
  });
  if (!commandExists(executable)) return Object.freeze({
    state: 'blocked', code: 'MODEL_PROVIDER_UNAVAILABLE', capability: 'prompt-attachment', executable
  });
  const probe = spawnSync(executable, ['--help'], {
    encoding: 'utf8', windowsHide: true, timeout: 5000, shell: false
  });
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  const supported = probe.status === 0 && /(^|\s)--attachment(?:\s|=|<|\[|$)/m.test(output);
  return Object.freeze({
    state: supported ? 'ready' : 'blocked',
    code: supported ? null : 'MODEL_PROVIDER_CAPABILITY_MISSING',
    capability: 'prompt-attachment',
    executable
  });
}
