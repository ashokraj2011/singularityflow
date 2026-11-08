/** Native executable/path values and explicit process-tree signaling; no repository discovery. */
import path from 'node:path';

export function processEnvironmentValue(environment, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const key = Object.keys(environment ?? {}).find((entry) => wanted.has(entry.toLowerCase()));
  return key == null ? null : environment[key];
}

/** Root-relative (`\\tool.exe`) and drive-relative (`C:tool.exe`) paths are not identities. */
export function isFullyQualifiedWindowsPath(value, { allowUnc = true } = {}) {
  const candidate = String(value ?? '').trim();
  if (/^[a-z]:[\\/]/i.test(candidate)) return true;
  if (!allowUnc || !candidate.startsWith('\\\\') || /^\\\\[?.][\\/]/u.test(candidate)) return false;
  const parts = candidate.slice(2).split(/[\\/]+/u);
  return parts.length >= 3 && parts[0].length > 0 && parts[1].length > 0;
}

export function resolveWindowsSystemTool(environment, name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/i.test(name)) {
    throw new TypeError('Windows system-tool name must be one safe basename.');
  }
  const systemRoot = processEnvironmentValue(environment, ['SystemRoot', 'WINDIR']);
  if (typeof systemRoot === 'string'
      && isFullyQualifiedWindowsPath(systemRoot.trim(), { allowUnc: false })) {
    return path.win32.join(systemRoot.trim(), 'System32', name);
  }
  throw new TypeError(`Windows cannot resolve trusted ${name} without an absolute SystemRoot or WINDIR.`);
}


/**
 * Attempt Windows descendant-tree termination without letting an untrusted/missing machine
 * environment escape a timeout or abort callback. Callers must directly signal the child when
 * this returns false; the boolean proves only that taskkill accepted the complete tree request.
 */
export function tryWindowsTaskkill(pid, {
  force = false,
  environment = process.env,
  spawnSyncCommand,
  timeoutMs = 5_000
} = {}) {
  const processId = Number(pid);
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    const result = spawnSyncCommand(resolveWindowsSystemTool(environment, 'taskkill.exe'), [
      '/PID', String(processId), '/T', ...(force ? ['/F'] : [])
    ], {
      stdio: 'ignore', windowsHide: true, timeout: timeoutMs, shell: false
    });
    return !result?.error && result?.status === 0;
  } catch {
    return false;
  }
}



/** Host-only selection policy; no repository scan, subprocess, credentials, or Xcode dependency. */
export function isAppleDeveloperGit(executable) {
  return executable === '/usr/bin/git'
    || executable === '/Library/Developer/CommandLineTools/usr/bin/git'
    || /\/Xcode[^/]*\.app\/Contents\/Developer\/usr\/bin\/git$/u.test(executable);
}

export function gitHostSearchDirectories(environment, platform = process.platform) {
  const key = Object.keys(environment ?? {}).find((entry) => entry.toLowerCase() === 'path');
  const entries = String(key == null ? '' : environment[key]).split(platform === 'win32' ? ';' : ':').slice(0, 128);
  // GUI hosts often receive /usr/bin first (and no shell Homebrew setup). Only supplement that
  // Apple-toolchain search with fixed machine install locations, never cwd, HOME, or a scan.
  if (platform === 'darwin' && entries.some((directory) => isAppleDeveloperGit(`${directory}/git`))) {
    entries.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin');
  }
  return [...new Set(entries)];
}

/** Keep hooks/helpers that launch bare Git on the same macOS installation as their parent. */
export function gitHostChildEnvironment(environment, executable, platform = process.platform) {
  if (platform !== 'darwin' || !path.isAbsolute(executable)) return environment;
  const env = { ...environment };
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === 'path');
  const originalPath = String(key == null ? '' : env[key]);
  for (const entry of Object.keys(env)) if (entry.toLowerCase() === 'path') delete env[entry];
  env.PATH = [path.dirname(executable), originalPath].filter(Boolean).join(':');
  return env;
}

export const APPLE_GIT_UNAVAILABLE_MESSAGE = 'Apple Git could not run because its developer-tool setup is incomplete. '
  + 'Xcode is optional for Singularity Flow. Use a working standalone Git installation on PATH, then reload VS Code and retry. '
  + 'The existing Story checkout and Git configuration must be preserved.';

export function gitDeveloperToolsUnavailable(result, platform = process.platform) {
  if (platform !== 'darwin' || result?.status === 0 || result?.error || result?.signal
      || result?.timedOut || result?.outputOverflow || result?.aborted || result?.blocked) return false;
  const message = String(result?.stderr ?? '').slice(0, 4096);
  return /You have not agreed to the Xcode license agreements/u.test(message)
    || /xcode-select: error: (?:no developer tools were found|invalid developer directory)/iu.test(message)
    || /xcrun: error: invalid active developer path/iu.test(message);
}
