import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';

const WINDOWS_BATCH = /\.(?:cmd|bat)$/i;
const WINDOWS_PACKAGE_MANAGERS = new Set(['npm', 'npx']);
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const CMD_ENV_EXPANSION = /[%!]/;
const WINDOWS_EXECUTABLE_CACHE = new Map();
const WINDOWS_EXECUTABLE_CACHE_LIMIT = 128;

function safeCommand(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new TypeError('Process command must be a non-empty command or path.');
  }
  return value.trim();
}

function safeArguments(values) {
  if (!Array.isArray(values)) throw new TypeError('Process arguments must be an array.');
  return values.map((value) => {
    const argument = String(value);
    if (/[\r\n\0]/.test(argument)) {
      throw new TypeError('Windows batch arguments cannot contain control characters.');
    }
    // cmd.exe expands percent-delimited variables before ordinary caret/quote processing, and an
    // inherited delayed-expansion mode can reinterpret exclamation marks. There is no lossless,
    // locale-independent encoding for those bytes through a .cmd shim. Governed npm/npx launches
    // therefore refuse them instead of executing an argv different from the one policy reviewed.
    if (CMD_ENV_EXPANSION.test(argument)) {
      throw new TypeError('Windows batch arguments cannot contain % or ! because cmd.exe would reinterpret them.');
    }
    return argument;
  });
}

function environmentValue(environment, names) {
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
  const systemRoot = environmentValue(environment, ['SystemRoot', 'WINDIR']);
  if (typeof systemRoot === 'string'
      && isFullyQualifiedWindowsPath(systemRoot.trim(), { allowUnc: false })) {
    return path.win32.join(systemRoot.trim(), 'System32', name);
  }
  throw new TypeError(`Windows cannot resolve trusted ${name} without an absolute SystemRoot or WINDIR.`);
}

function absoluteWindowsCommandInterpreter(environment) {
  const expected = resolveWindowsSystemTool(environment, 'cmd.exe');
  const comSpec = environmentValue(environment, ['ComSpec']);
  if (typeof comSpec === 'string' && comSpec.trim()) {
    if (!isFullyQualifiedWindowsPath(comSpec.trim(), { allowUnc: false })
        || path.win32.normalize(comSpec.trim()).toLowerCase() !== expected.toLowerCase()) {
      throw new TypeError('Windows ComSpec must identify the cmd.exe under SystemRoot\\System32.');
    }
  }
  return expected;
}

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META, '^$1');
}

// cmd.exe parses the /c payload twice. Quote/backslash handling and metacharacters therefore need
// the same two-pass escaping used by the provider launcher. This is a narrow batch-shim adapter,
// not generic shell execution: the logical command and every argument remain separate until this
// final Windows process boundary.
function escapeCmdArgument(value) {
  let escaped = String(value);
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META, '^$1');
  return escaped.replace(CMD_META, '^$1');
}

function windowsBatchArguments(target, args) {
  if (CMD_ENV_EXPANSION.test(target)) {
    throw new TypeError('Windows batch executable paths cannot contain % or ! because cmd.exe would reinterpret them.');
  }
  const commandLine = [
    escapeCmdCommand(target),
    ...args.map((argument) => escapeCmdArgument(argument))
  ].join(' ');
  return ['/d', '/s', '/v:off', '/c', `"${commandLine}"`];
}

export function isWindowsBatchExecutable(value) {
  return WINDOWS_BATCH.test(String(value ?? ''));
}

/** The one safely escaped, shell-free cmd.exe adapter used for reviewed Windows batch shims. */
export function resolveWindowsBatchProcess(target, args = [], { environment = process.env } = {}) {
  const physicalExecutable = safeCommand(target);
  if (!isFullyQualifiedWindowsPath(physicalExecutable)) {
    throw new TypeError('Windows batch executables must use a fully qualified path.');
  }
  const logicalArguments = safeArguments(args);
  const executable = absoluteWindowsCommandInterpreter(environment);
  return Object.freeze({
    physicalExecutable,
    executable,
    arguments: Object.freeze(windowsBatchArguments(physicalExecutable, logicalArguments)),
    spawnOptions: Object.freeze({ shell: false, windowsVerbatimArguments: true })
  });
}

function windowsPackageManagerName(command) {
  const basename = path.win32.basename(command).toLowerCase();
  if (WINDOWS_PACKAGE_MANAGERS.has(basename)) return basename;
  if (WINDOWS_BATCH.test(basename)
      && WINDOWS_PACKAGE_MANAGERS.has(basename.replace(WINDOWS_BATCH, ''))) {
    return basename.replace(WINDOWS_BATCH, '');
  }
  return null;
}


function resolveWindowsPackageManagerTarget(command, {
  environment, spawnSyncCommand
}) {
  const manager = windowsPackageManagerName(command);
  if (!manager) return null;
  const requested = WINDOWS_BATCH.test(command) ? command : `${command}.cmd`;
  if (isFullyQualifiedWindowsPath(requested)) return requested;
  if (requested !== path.win32.basename(requested)) {
    throw new TypeError('Windows package-manager batch paths must be absolute or resolved from PATH.');
  }

  // `cmd.exe /c npm.cmd` searches the child cwd before PATH. Resolve through the same PATH-only,
  // bounded cache as every other executable, then pass only the absolute result to cmd.exe.
  const target = resolveWindowsPathExecutable(`${manager}.cmd`, {
    environment, spawnSyncCommand
  });
  if (!target) throw new TypeError(`Windows could not resolve an absolute ${manager}.cmd from PATH.`);
  return target;
}

/**
 * Resolve one bare Windows command from PATH without ever consulting the child working directory.
 *
 * CreateProcess and cmd.exe both permit a repository-local executable to shadow PATH. Windows'
 * `where.exe` has an explicit `$PATH:` namespace, but invoking `where` by basename merely moves the
 * same vulnerability to the lookup itself. Use the absolute System32 binary, a System32 cwd, and
 * accept only absolute results whose basename is exactly one of the requested candidates.
 */
export function resolveWindowsPathExecutable(command, {
  environment = process.env,
  spawnSyncCommand = spawnSync,
  cache = spawnSyncCommand === spawnSync,
  lstatSyncCommand = lstatSync
} = {}) {
  const requested = safeCommand(command);
  if (isFullyQualifiedWindowsPath(requested)) return requested;
  if (path.win32.isAbsolute(requested)) {
    throw new TypeError('Root-relative and drive-relative Windows executable paths are not allowed.');
  }
  if (requested !== path.win32.basename(requested)) {
    throw new TypeError('Relative Windows executable paths are not allowed; use one PATH basename or an absolute path.');
  }

  const basename = path.win32.basename(requested);
  const extension = path.win32.extname(basename).toLowerCase();
  const configuredExtensions = String(environmentValue(environment, ['PATHEXT']) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^\.[a-z0-9]+$/i.test(entry))
    .filter((entry) => ['.com', '.exe', '.cmd', '.bat'].includes(entry));
  const extensions = configuredExtensions.length
    ? [...new Set(configuredExtensions)] : ['.com', '.exe', '.bat', '.cmd'];
  const candidates = extension ? [basename] : extensions.map((entry) => `${basename}${entry}`);
  const pathValue = String(environmentValue(environment, ['PATH']) ?? '');
  const cacheKey = [basename.toLowerCase(), pathValue, extensions.join(';'),
    String(environmentValue(environment, ['SystemRoot', 'WINDIR']) ?? '')].join('\0');
  if (cache && WINDOWS_EXECUTABLE_CACHE.has(cacheKey)) {
    const cached = WINDOWS_EXECUTABLE_CACHE.get(cacheKey);
    try {
      const info = lstatSyncCommand(cached);
      if (info?.isFile?.() && !info.isSymbolicLink?.()) return cached;
    } catch { /* moved or uninstalled; resolve again */ }
    WINDOWS_EXECUTABLE_CACHE.delete(cacheKey);
  }
  const whereExecutable = resolveWindowsSystemTool(environment, 'where.exe');
  const pathPattern = extension ? basename : `${basename}.*`;
  const result = spawnSyncCommand(whereExecutable, [`$PATH:${pathPattern}`], {
    cwd: path.win32.dirname(whereExecutable),
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    shell: false
  });
  if (result?.error || result?.status !== 0) return null;
  const allowed = new Set(candidates.map((entry) => entry.toLowerCase()));
  const resolved = String(result.stdout ?? '').split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => isFullyQualifiedWindowsPath(entry)
      && allowed.has(path.win32.basename(entry).toLowerCase()));
  let selected = null;
  for (const candidate of candidates) {
    selected = resolved.find((entry) => path.win32.basename(entry).toLowerCase()
      === candidate.toLowerCase()) ?? null;
    if (selected) break;
  }
  if (selected && cache) {
    try {
      const info = lstatSyncCommand(selected);
      if (!info?.isFile?.() || info.isSymbolicLink?.()) selected = null;
    } catch { selected = null; }
  }
  if (selected && cache) {
    if (WINDOWS_EXECUTABLE_CACHE.size >= WINDOWS_EXECUTABLE_CACHE_LIMIT) {
      WINDOWS_EXECUTABLE_CACHE.delete(WINDOWS_EXECUTABLE_CACHE.keys().next().value);
    }
    WINDOWS_EXECUTABLE_CACHE.set(cacheKey, selected);
  }
  return selected;
}

export function clearWindowsExecutableCache() {
  WINDOWS_EXECUTABLE_CACHE.clear();
}

/**
 * Attempt Windows descendant-tree termination without letting an untrusted/missing machine
 * environment escape a timeout or abort callback. Callers must directly signal the child when
 * this returns false; the boolean proves only that taskkill accepted the complete tree request.
 */
export function tryWindowsTaskkill(pid, {
  force = false,
  environment = process.env,
  spawnSyncCommand = spawnSync,
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

function resolveWindowsLocalExecutable(command, cwd, lstatSyncCommand, realpathSyncCommand) {
  if (typeof cwd !== 'string' || !isFullyQualifiedWindowsPath(cwd)) {
    throw new TypeError('Explicit repository-relative Windows executables require an absolute cwd.');
  }
  const root = path.win32.resolve(cwd);
  const candidate = path.win32.resolve(root, command);
  if (candidate.toLowerCase() === root.toLowerCase()) {
    throw new TypeError('Explicit repository-relative Windows executable must identify a file below its verified cwd.');
  }
  const rootPrefix = `${root.replace(/[\\/]+$/u, '')}\\`.toLowerCase();
  if (candidate.toLowerCase() !== root.toLowerCase()
      && !candidate.toLowerCase().startsWith(rootPrefix)) {
    throw new TypeError('Explicit repository-relative Windows executable escapes its verified cwd.');
  }
  const relative = path.win32.relative(root, candidate);
  let current = root;
  const segments = relative.split(/[\\/]+/u).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.win32.join(current, segments[index]);
    let info;
    try { info = lstatSyncCommand(current); }
    catch { throw new TypeError('Explicit repository-relative Windows executable is unavailable.'); }
    if (info.isSymbolicLink?.()) {
      throw new TypeError('Explicit repository-relative Windows executable cannot traverse a symlink or junction.');
    }
    if (index === segments.length - 1 && !info?.isFile?.()) {
      throw new TypeError('Explicit repository-relative Windows executable must be a regular non-symlink file.');
    }
  }
  let canonicalRoot; let canonicalCandidate;
  try {
    canonicalRoot = path.win32.normalize(realpathSyncCommand(root));
    canonicalCandidate = path.win32.normalize(realpathSyncCommand(candidate));
  } catch {
    throw new TypeError('Explicit repository-relative Windows executable cannot be canonicalized.');
  }
  const canonicalPrefix = `${canonicalRoot.replace(/[\\/]+$/u, '')}\\`.toLowerCase();
  if (canonicalCandidate.toLowerCase() !== canonicalRoot.toLowerCase()
      && !canonicalCandidate.toLowerCase().startsWith(canonicalPrefix)) {
    throw new TypeError('Explicit repository-relative Windows executable escapes its canonical cwd.');
  }
  return candidate;
}

/**
 * Resolve an argv-preserving process launch without changing its logical command identity.
 *
 * Node cannot execute `.cmd` shims directly on Windows. Every bare command is first resolved from
 * PATH without consulting the repository cwd. Batch shims are then launched through ComSpec with
 * verbatim, escaped argv and `shell:false`; native executables remain direct spawns. Callers must
 * continue to hash/audit `logicalCommand` and `logicalArguments`, never the platform wrapper.
 */
export function resolvePlatformProcess(command, args = [], {
  platform = process.platform,
  environment = process.env,
  spawnSyncCommand = spawnSync,
  cwd = null,
  lstatSyncCommand = lstatSync,
  realpathSyncCommand = realpathSync
} = {}) {
  const logicalCommand = safeCommand(command);
  const logicalArguments = args.map(String);
  if (platform !== 'win32') {
    return Object.freeze({
      logicalCommand,
      logicalArguments: Object.freeze(logicalArguments),
      physicalExecutable: logicalCommand,
      executable: logicalCommand,
      arguments: Object.freeze([...logicalArguments]),
      spawnOptions: Object.freeze({ shell: false })
    });
  }

  if (path.win32.isAbsolute(logicalCommand) && !isFullyQualifiedWindowsPath(logicalCommand)) {
    throw new TypeError('Root-relative and drive-relative Windows executable paths are not allowed.');
  }
  if (/^[a-z]:(?:$|[^\\/])/i.test(logicalCommand)) {
    throw new TypeError('Drive-relative Windows executable paths are not allowed.');
  }
  const explicitlyRelative = !isFullyQualifiedWindowsPath(logicalCommand)
    && logicalCommand !== path.win32.basename(logicalCommand);
  let physicalExecutable = explicitlyRelative
    ? resolveWindowsLocalExecutable(logicalCommand, cwd, lstatSyncCommand, realpathSyncCommand)
    : resolveWindowsPackageManagerTarget(logicalCommand, { environment, spawnSyncCommand });
  if (!physicalExecutable) {
    physicalExecutable = isFullyQualifiedWindowsPath(logicalCommand)
      ? logicalCommand
      : resolveWindowsPathExecutable(logicalCommand, { environment, spawnSyncCommand });
  }
  if (!physicalExecutable) {
    throw new TypeError(`Windows could not resolve ${logicalCommand} from PATH.`);
  }

  if (!isWindowsBatchExecutable(physicalExecutable)) {
    return Object.freeze({
      logicalCommand,
      logicalArguments: Object.freeze(logicalArguments),
      physicalExecutable,
      executable: physicalExecutable,
      arguments: Object.freeze([...logicalArguments]),
      spawnOptions: Object.freeze({ shell: false })
    });
  }

  const batch = resolveWindowsBatchProcess(physicalExecutable, logicalArguments, { environment });
  return Object.freeze({
    logicalCommand,
    logicalArguments: Object.freeze(logicalArguments),
    physicalExecutable,
    executable: batch.executable,
    arguments: batch.arguments,
    spawnOptions: batch.spawnOptions
  });
}
