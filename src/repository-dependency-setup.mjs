/**
 * SFlow makes a Story checkout's dependencies ready itself [owner, 2026-11-19, "SFlow prepares the code environment"].
 *
 * On the owner's laptop `/sf-code` stopped on "Dependencies are absent (npm ci is needed)": a new Story checkout starts
 * without `node_modules`, only Auto flights copied them (repository-dependencies.mjs), and the agent may not install
 * anything. So when a code version opens, and before a Story's tests run, SFlow does what a developer would, for each
 * package folder the tests run in (the nearest folder at or above it with a lock file):
 *
 *   - its lock file is byte for byte the main checkout's (a workspace's clone, for a Story checked out from one), and the
 *     main checkout installed its dependencies after that lock file last changed: they are copied, as Auto copies them
 *     (reflinked where the disk can; links bound to this checkout's own source; never a link to the other checkout, so
 *     nothing either one does reaches the other);
 *   - otherwise the repository's own install runs there, chosen from its lock file and `packageManager`: `npm ci`,
 *     `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` (Yarn 1) or `--immutable` (Yarn 2 and later),
 *     `bun install --frozen-lockfile`. It runs on the Node the Story's tests run on (project-node-version.mjs), with its
 *     install scripts, as a developer's own install would; none of these changes the lock file.
 *
 * A folder that already has `node_modules` (or Yarn's `.pnp.cjs`), has no lock file, or whose package.json declares no
 * dependency, is left as it is. One line says what happens ("Installing dependencies (npm ci)…"). Nothing here ever
 * refuses: a copy that cannot be made falls back to the install, and an install that fails is said in plain words with
 * one next action, the exact command for the person's own terminal, and the tests still run.
 *
 * Off for a repository with `repositoryReadiness.dependencyHydration: off`, and for this machine with
 * SINGULARITY_FLOW_DEPENDENCY_SETUP=off.
 */
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const LOCK_FILES = Object.freeze([
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']
]);
// Each package manager leaves one of these in node_modules when it installs: older than the lock file means an install
// from an earlier lock file, which is never copied.
const INSTALL_MARKERS = Object.freeze(['.package-lock.json', '.modules.yaml', '.yarn-integrity', '.yarn-state.yml']);
const MAX_FOLDERS = 8;
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
const MAX_REASON = 400;

const stderrLine = (line) => process.stderr.write(`${line}\n`);
const absolute = (root, relative) => (relative === '.' ? root : path.join(root, ...relative.split('/')));
const joined = (directory, name) => (directory === '.' ? name : `${directory}/${name}`);
const there = (file) => lstat(file).then(() => true, () => false);
const where = (directory) => (directory === '.' ? 'the repository root' : directory);
// The install folders this process already tried, so one gate's several runs never install twice. A long-lived host
// process tries a failed one again after a while: the person may have fixed what stopped it.
const attempted = new Map();
const RETRY_AFTER_MS = 10 * 60_000;
const remembered = (key) => {
  const kept = attempted.get(key);
  return kept && Date.now() - kept.at < RETRY_AFTER_MS ? kept.outcome : null;
};
const remember = (key, outcome) => { attempted.set(key, { outcome, at: Date.now() }); return outcome; };

function normalized(directory) {
  const value = path.posix.normalize(String(directory ?? '.').replaceAll('\\', '/')).replace(/^\.\/+/u, '').replace(/\/+$/u, '');
  return !value || value === '.' ? '.' : value.startsWith('../') || path.posix.isAbsolute(value) ? null : value;
}

function parsed(text) {
  try { const value = JSON.parse(text ?? 'null'); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}

/** Whether the machine or the repository turned this off. */
export function dependencySetupOff(config, environment = process.env) {
  return String(environment.SINGULARITY_FLOW_DEPENDENCY_SETUP ?? '').toLowerCase() === 'off'
    || config?.repositoryReadiness?.dependencyHydration === 'off';
}

/**
 * The package folder a command in `directory` installs into: the nearest folder at or above it with a package.json and a
 * lock file, `{ directory, lockFile, manager, manifest, argv, words, target }`, or null.
 */
export async function installFolder(root, directory) {
  for (let at = directory; ; at = path.posix.dirname(at)) {
    const folder = absolute(root, at);
    const locks = [];
    for (const [name, manager] of LOCK_FILES) if (await there(path.join(folder, name))) locks.push({ name, manager });
    const manifestText = locks.length ? await readFile(path.join(folder, 'package.json'), 'utf8').catch(() => null) : null;
    if (manifestText !== null) {
      const manifest = parsed(manifestText) ?? {};
      // `packageManager` says which one, when its lock file is here; else the first lock file found.
      const declared = String(manifest.packageManager ?? '').split('@')[0].toLowerCase();
      const lock = locks.find((entry) => entry.manager === declared) ?? locks[0];
      return { directory: at, lockFile: lock.name, manager: lock.manager, manifest, ...await installCommand(folder, lock.manager, manifest) };
    }
    if (at === '.') return null;
  }
}

/** The repository's own install for a folder: `{ argv, words, target }`, `target` being what the install creates. */
async function installCommand(folder, manager, manifest) {
  if (manager === 'pnpm') return { argv: ['pnpm', 'install', '--frozen-lockfile'], words: 'pnpm install --frozen-lockfile', target: 'node_modules' };
  if (manager === 'bun') return { argv: ['bun', 'install', '--frozen-lockfile'], words: 'bun install --frozen-lockfile', target: 'node_modules' };
  if (manager === 'yarn') {
    const declared = Number(/^yarn@(\d+)/iu.exec(String(manifest.packageManager ?? ''))?.[1]);
    const settings = await readFile(path.join(folder, '.yarnrc.yml'), 'utf8').catch(() => null);
    if (Number.isFinite(declared) ? declared >= 2 : settings !== null) {
      // Yarn 2 and later install Plug'n'Play unless told otherwise: no node_modules, a .pnp.cjs.
      const nodeModules = /^\s*nodeLinker\s*:\s*["']?node-modules\b/mu.test(settings ?? '');
      return { argv: ['yarn', 'install', '--immutable'], words: 'yarn install --immutable', target: nodeModules ? 'node_modules' : '.pnp.cjs' };
    }
    return { argv: ['yarn', 'install', '--frozen-lockfile'], words: 'yarn install --frozen-lockfile', target: 'node_modules' };
  }
  // npm says nothing it need not: what it prints about funding and audits is no help here.
  return { argv: ['npm', 'ci', '--no-audit', '--no-fund'], words: 'npm ci', target: 'node_modules' };
}

/** Whether the folder's package.json asks for anything to install at all. */
async function declaresDependencies(root, folder) {
  const { manifest } = folder;
  const named = ['dependencies', 'devDependencies', 'optionalDependencies']
    .some((field) => manifest[field] && typeof manifest[field] === 'object' && Object.keys(manifest[field]).length);
  return named || Boolean(manifest.workspaces) || await there(path.join(absolute(root, folder.directory), 'pnpm-workspace.yaml'));
}

/** The checkout the repository was cloned into (the main checkout), when `root` is another checkout of it; else null. */
async function mainCheckout(root) {
  const { gitCommonDir } = await import('./git.mjs');
  const common = await realpath(gitCommonDir(root)).catch(() => null);
  if (!common || path.basename(common) !== '.git') return null;
  const main = path.dirname(common);
  if (main === await realpath(root).catch(() => root)) return null;
  return (await lstat(path.join(main, '.git')).catch(() => null))?.isDirectory() ? main : null;
}

/** Whether `source` installed this folder's dependencies from the same lock file, and since that lock file last changed. */
async function installedFromSameLock(root, source, folder) {
  const lock = (base) => path.join(absolute(base, folder.directory), folder.lockFile);
  const [mine, theirs, lockInfo] = await Promise.all([readFile(lock(root)).catch(() => null), readFile(lock(source)).catch(() => null), stat(lock(source)).catch(() => null)]);
  if (!mine || !theirs || !mine.equals(theirs)) return false;
  const modules = path.join(absolute(source, folder.directory), 'node_modules');
  if (!(await lstat(modules).catch(() => null))?.isDirectory() || !(await readdir(modules).catch(() => [])).length) return false;
  for (const name of INSTALL_MARKERS) {
    const marker = await stat(path.join(modules, name)).catch(() => null);
    if (marker) return marker.mtimeMs + 1000 >= lockInfo.mtimeMs;
  }
  return true;
}

/** The dependency folders of `source` that belong to this package folder: its own, and its workspaces' with no lock file between. */
async function foldersOf(source, folder) {
  const { ignoredDirectories } = await import('./git.mjs');
  const inside = folder.directory === '.' ? '' : `${folder.directory}/`;
  const belongs = new Set();
  for (const relative of ignoredDirectories(source)) {
    if (path.posix.basename(relative) !== 'node_modules' || (inside && !relative.startsWith(inside))) continue;
    let own = true;
    for (let at = path.posix.dirname(relative); at !== folder.directory && at !== '.'; at = path.posix.dirname(at)) {
      if (await Promise.any(LOCK_FILES.map(([name]) => lstat(path.join(absolute(source, at), name)))).then(() => true, () => false)) { own = false; break; }
    }
    if (own) belongs.add(relative);
  }
  return belongs;
}

/** The environment an install runs in: the Story's Node first on PATH, and none of SFlow's own host or test variables. */
async function installEnvironment(root, cwd, environment) {
  const [{ withProjectNodeVersion }, { withoutHostSurfaceVariables }] = await Promise.all([import('./test-run-environment.mjs'), import('./quality-command-runner.mjs')]);
  const requested = await withProjectNodeVersion(environment, { cwd, root }).catch(() => ({ environment }));
  const prepared = withoutHostSurfaceVariables({ ...requested.environment });
  for (const key of Object.keys(prepared)) if (key.toUpperCase() === 'NODE_TEST_CONTEXT') delete prepared[key];
  return prepared;
}

/** Why an install failed, in a developer's words, from how it ended and the last lines it printed. */
export function installFailure(folder, result, { cwd, words, platform = process.platform }) {
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const lastLine = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).filter((line) => !/^npm (?:ERR!|error) (?:A complete log|$)/u.test(line)).at(-1) ?? '';
  const tool = folder.argv[0];
  const run = { label: `Run ${words} in ${cwd} yourself, then run the tests again.`, command: words, workingDirectory: cwd };
  let reason;
  if (result.error?.code === 'ENOENT' || /\b(?:command not found|is not recognized as an internal or external command|ENOENT)\b/u.test(output) && !/npm (?:ERR!|error) code/u.test(output)) {
    reason = `${tool} is not installed on this machine`;
    const enable = tool === 'pnpm' || tool === 'yarn' ? 'corepack enable' : tool === 'bun' ? 'npm install --global bun' : null;
    return { directory: folder.directory, words: `Dependencies in ${where(folder.directory)} were not installed: ${reason}.`, reason,
      // Windows PowerShell 5 has no `&&`: there the two commands are named, and the install is the one to run.
      nextAction: enable ? { label: `Install ${tool} (${enable}), then run ${words} in ${cwd}.`,
        command: platform === 'win32' ? words : `${enable} && ${words}`, workingDirectory: cwd } : run };
  }
  if (result.timedOut) reason = `${words} did not finish within ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} minutes`;
  else if (/can only install (?:packages )?when your package\.json and package-lock\.json|are in sync|lockfile (?:needs to be updated|would have been modified)|ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile|YN0028/iu.test(output)) {
    reason = `${folder.lockFile} does not match package.json, so ${words} will not install from it`;
    const update = folder.manager === 'npm' ? 'npm install' : folder.manager === 'pnpm' ? 'pnpm install' : folder.manager === 'bun' ? 'bun install' : 'yarn install';
    return { directory: folder.directory, words: `Dependencies in ${where(folder.directory)} were not installed: ${reason}. Updating it is a change to name in the plan.`, reason,
      nextAction: { label: `Run ${update} in ${cwd} to update ${folder.lockFile}.`, command: update, workingDirectory: cwd } };
  } else if (/\b(?:E401|E403|EAUTH|ENEEDAUTH|Unable to authenticate|authentication (?:token|required)|401 Unauthorized|403 Forbidden)\b/iu.test(output)) {
    reason = 'the package registry refused the credentials this run had';
  } else if (/\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|network|getaddrinfo|socket hang up|self[- ]signed certificate|UNABLE_TO_GET_ISSUER_CERT)\b/iu.test(output)) {
    reason = 'the package registry could not be reached from this run';
  } else {
    reason = `${words} ended with exit ${result.status ?? 'unknown'}${lastLine ? `: ${lastLine.slice(0, MAX_REASON)}` : ''}`;
  }
  return { directory: folder.directory, words: `Dependencies in ${where(folder.directory)} were not installed: ${reason}.`, reason, nextAction: run };
}

/**
 * Make the dependencies of each package folder `directories` (repository paths, `.` the root) run in ready, in the
 * checkout at `root`. Returns `{ status, folders, failure }`: `status` is `ready`, `failed` or `off`; each folder says
 * `how` (`present`, `copied`, `installed`, `nothing-to-install`, `failed`); `failure` is the first failed folder's plain
 * reason and `nextAction`, or null. Never rejects.
 */
export async function prepareRepositoryDependencies(root, {
  config = null, directories = ['.'], environment = process.env, say = stderrLine, run = null, source = undefined, timeoutMs = INSTALL_TIMEOUT_MS
} = {}) {
  if (dependencySetupOff(config, environment)) return { status: 'off', folders: [], failure: null };
  const folders = [];
  const seen = new Set();
  try {
    for (const directory of [...new Set(directories.map(normalized).filter(Boolean))]) {
      const folder = await installFolder(root, directory).catch(() => null);
      if (!folder || seen.has(folder.directory) || seen.size >= MAX_FOLDERS) continue;
      seen.add(folder.directory);
      folders.push(await prepareFolder(root, folder, { environment, say, run, source, timeoutMs }));
    }
  } catch (error) {
    folders.push({ directory: '.', how: 'failed', failure: { directory: '.', words: `Dependencies were not made ready: ${String(error?.message ?? error).slice(0, MAX_REASON)}`,
      reason: String(error?.message ?? error).slice(0, MAX_REASON), nextAction: null } });
  }
  const failure = folders.find((entry) => entry.failure)?.failure ?? null;
  return { status: failure ? 'failed' : 'ready', folders, failure };
}

async function prepareFolder(root, folder, { environment, say, run, source, timeoutMs }) {
  const cwd = absolute(root, folder.directory);
  const shown = { directory: folder.directory, command: folder.words };
  if (await there(path.join(cwd, folder.target)) || await there(path.join(cwd, 'node_modules'))) return { ...shown, how: 'present' };
  if (!await declaresDependencies(root, folder)) return { ...shown, how: 'nothing-to-install' };
  const key = `${await realpath(cwd).catch(() => cwd)}\0${folder.words}`;
  if (remembered(key)) return remembered(key);
  const { ignoresDirectory } = await import('./git.mjs');
  const relative = joined(folder.directory, folder.target);
  // Copied or installed, the folder must be one Git ignores here, or it would join the change.
  if (folder.target === 'node_modules' && !ignoresDirectory(root, relative)) {
    const outcome = { ...shown, how: 'failed', failure: { directory: folder.directory,
      words: `Dependencies in ${where(folder.directory)} were not installed: ${relative} is not in .gitignore here, so installing would add it to your change. Adding it to .gitignore is a change to name in the plan.`,
      reason: `${relative} is not in .gitignore`,
      nextAction: { label: `Add node_modules/ to .gitignore, or run ${folder.words} in ${cwd} yourself.`,
        command: folder.words, workingDirectory: cwd } } };
    return remember(key, outcome);
  }
  // The main checkout's, when it installed from this same lock file: a copy, as Auto flights get theirs.
  const from = source === undefined ? await mainCheckout(root).catch(() => null) : source;
  if (folder.target === 'node_modules' && from && await installedFromSameLock(root, from, folder).catch(() => false)) {
    say(`Copying installed dependencies into ${where(folder.directory)} from the main checkout (same ${folder.lockFile})…`);
    const belongs = await foldersOf(from, folder).catch(() => new Set());
    const { copyRepositoryDependencies } = await import('./repository-dependencies.mjs');
    const copied = belongs.size ? await copyRepositoryDependencies(from, root, { only: (entry) => belongs.has(entry) }).catch(() => null) : null;
    if (copied?.copied.includes(relative)) return remember(key, { ...shown, how: 'copied', from: 'main checkout' });
  }
  return remember(key, await install(root, folder, { cwd, environment, say, run, timeoutMs, shown }));
}

async function install(root, folder, { cwd, environment, say, run, timeoutMs, shown }) {
  const [{ changedFiles }, runner] = await Promise.all([import('./git.mjs'), run ? null : import('./quality-command-runner.mjs')]);
  const execute = run ?? ((argv, options) => runner.runQualityCommand(argv[0], argv.slice(1), options));
  say(`Installing dependencies (${folder.words})${folder.directory === '.' ? '' : ` in ${folder.directory}`}…`);
  const before = new Set(changedFiles(root));
  const result = await execute(folder.argv, { cwd, env: await installEnvironment(root, cwd, environment), timeoutMs, killTree: true })
    .catch((error) => ({ status: null, error, stdout: '', stderr: String(error?.message ?? error) }));
  const done = result.status === 0 && !result.error && !result.timedOut;
  // Install scripts run as a developer's own would; a file Git sees that one wrote is said, never hidden.
  const wrote = changedFiles(root).filter((file) => !before.has(file)).slice(0, 10);
  const note = wrote.length ? `The install also changed ${wrote.join(', ')}; keep ${wrote.length === 1 ? 'it' : 'them'} out of your change unless ${wrote.length === 1 ? 'it belongs' : 'they belong'} there.` : null;
  if (note) say(note);
  if (done) return { ...shown, how: 'installed', ...(note ? { note } : {}) };
  const failure = installFailure(folder, result, { cwd, words: folder.words });
  say(`${failure.words} ${failure.nextAction?.label ?? ''}`.trim());
  return { ...shown, how: 'failed', failure, ...(note ? { note } : {}) };
}

/** Forget what this process tried; for tests. */
export function resetDependencySetupAttempts() {
  attempted.clear();
}
