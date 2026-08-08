import { spawnSync } from 'node:child_process';

const providers = process.platform === 'darwin'
  ? [['pbcopy', []]]
  : process.platform === 'win32'
    ? [['clip', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];

export function copyToClipboard(value, { spawn = spawnSync } = {}) {
  for (const [command, args] of providers) {
    const result = spawn(command, args, { input: value, encoding: 'utf8' });
    if (!result.error && result.status === 0) return { status: 'copied', provider: command };
  }
  return { status: 'unavailable', reason: 'No supported clipboard provider is available.' };
}
