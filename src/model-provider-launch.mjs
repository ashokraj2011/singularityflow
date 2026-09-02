import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  isFullyQualifiedWindowsPath, isWindowsBatchExecutable, resolveWindowsBatchProcess,
  resolveWindowsPathExecutable
} from './platform-process.mjs';


function safeExecutable(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new TypeError('Model provider executable must be a non-empty command or path.');
  }
  return value.trim();
}

/**
 * Resolve one executable/argv launch contract shared by capability probes and provider execution.
 *
 * Windows npm commands are commonly `.cmd` shims, which Node cannot execute directly with
 * `shell:false`. Prefer a real `.exe` returned by the absolute System32 `where.exe` using its
 * PATH-only namespace; only when that trusted lookup returns a batch shim, use ComSpec with one
 * safely escaped, verbatim command string.
 */
export function resolveModelProviderLaunch(executable, {
  platform = process.platform,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  resolvedExecutable = null
} = {}) {
  const requested = safeExecutable(executable);
  if (platform !== 'win32') return Object.freeze({
    requested, target: requested, command: requested, available: true,
    arguments: (args) => [...args], spawnOptions: Object.freeze({ shell: false })
  });

  let candidates = [];
  if (resolvedExecutable) {
    const resolved = safeExecutable(resolvedExecutable);
    if (!isFullyQualifiedWindowsPath(resolved)) {
      throw new TypeError('Resolved Windows model-provider executable must be an absolute path.');
    }
    candidates = [resolved];
  }
  else if (isFullyQualifiedWindowsPath(requested)) candidates = existsSync(requested) ? [requested] : [];
  else {
    const resolved = resolveWindowsPathExecutable(requested, {
      environment, spawnSyncCommand: spawnSyncImpl
    });
    candidates = resolved ? [resolved] : [];
  }
  const target = candidates.find((candidate) => /\.exe$/i.test(candidate))
    ?? candidates.find((candidate) => isWindowsBatchExecutable(candidate))
    ?? candidates[0]
    ?? null;
  if (!target) return Object.freeze({
    requested, target: null, command: requested, available: false,
    arguments: (args) => [...args], spawnOptions: Object.freeze({ shell: false })
  });
  if (!isWindowsBatchExecutable(target)) return Object.freeze({
    requested, target, command: target, available: true,
    arguments: (args) => [...args], spawnOptions: Object.freeze({ shell: false })
  });
  const batch = resolveWindowsBatchProcess(target, [], { environment });
  return Object.freeze({
    requested, target, command: batch.executable, available: true,
    arguments: (args) => resolveWindowsBatchProcess(target, args, { environment }).arguments,
    spawnOptions: batch.spawnOptions
  });
}
