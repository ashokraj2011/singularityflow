import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const WINDOWS_SCRIPT = /\.(?:cmd|bat)$/i;
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function safeExecutable(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new TypeError('Model provider executable must be a non-empty command or path.');
  }
  return value.trim();
}

function whereCandidates(executable, spawnSyncImpl) {
  const queries = executable === 'copilot' ? ['copilot.exe', 'copilot'] : [executable];
  const candidates = [];
  for (const query of queries) {
    const result = spawnSyncImpl('where.exe', [query], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, shell: false
    });
    if (result.status !== 0) continue;
    for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && !candidates.some((entry) => entry.toLowerCase() === candidate.toLowerCase())) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META, '^$1');
}

// Adapted from the quoting contract used by mature cross-platform spawn wrappers. The command is
// passed as one verbatim /c program so cmd.exe cannot reinterpret a workspace path or model option
// as a second command. Prompts remain on ACP stdin and never enter this string.
function escapeCmdArgument(value, doubleEscapeMeta = true) {
  let escaped = String(value);
  if (/[\r\n\0]/.test(escaped)) throw new TypeError('Model provider arguments cannot contain control characters.');
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META, '^$1');
  if (doubleEscapeMeta) escaped = escaped.replace(CMD_META, '^$1');
  return escaped;
}

function windowsScriptArguments(target, args) {
  const command = [
    escapeCmdCommand(target),
    ...args.map((entry) => escapeCmdArgument(entry))
  ].join(' ');
  return ['/d', '/s', '/c', `"${command}"`];
}

/**
 * Resolve one executable/argv launch contract shared by capability probes and provider execution.
 *
 * Windows npm commands are commonly `.cmd` shims, which Node cannot execute directly with
 * `shell:false`. Prefer a real `.exe` returned by `where.exe`; only when the resolved program is a
 * batch shim, use ComSpec with one safely escaped, verbatim command string.
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
  if (resolvedExecutable) candidates = [safeExecutable(resolvedExecutable)];
  else if (path.win32.isAbsolute(requested)) candidates = existsSync(requested) ? [requested] : [];
  else candidates = whereCandidates(requested, spawnSyncImpl);
  const target = candidates.find((candidate) => /\.exe$/i.test(candidate))
    ?? candidates.find((candidate) => WINDOWS_SCRIPT.test(candidate))
    ?? candidates[0]
    ?? null;
  if (!target) return Object.freeze({
    requested, target: null, command: requested, available: false,
    arguments: (args) => [...args], spawnOptions: Object.freeze({ shell: false })
  });
  if (!WINDOWS_SCRIPT.test(target)) return Object.freeze({
    requested, target, command: target, available: true,
    arguments: (args) => [...args], spawnOptions: Object.freeze({ shell: false })
  });
  const command = environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe';
  return Object.freeze({
    requested, target, command, available: true,
    arguments: (args) => windowsScriptArguments(target, args),
    spawnOptions: Object.freeze({ shell: false, windowsVerbatimArguments: true })
  });
}
