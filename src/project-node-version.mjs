/**
 * The Node version a repository asks for, given to the commands SFlow runs for it [TCE:REQ-035].
 *
 * nvm is a shell function an interactive shell loads, and SFlow starts a repository's commands
 * without one. So a repository that pins Node in `.nvmrc` had its tests and builds run on whichever
 * `node` PATH found first, and the wrong Node read as a failure of the code.
 *
 * Each run looks from its working folder up to the repository root for `.nvmrc`, then
 * `.node-version`; the nearest wins. Then:
 *
 * - the `node` the run would find already matches (a version manager's shim answers for this folder
 *   too): nothing changes;
 * - an installed Node matches: the highest one goes first on the run's PATH, with the npm beside it;
 * - nothing installed matches, or the file names no version: the run goes ahead on what PATH finds
 *   and says so, with the install command for the version manager found here. SFlow never installs a
 *   Node, and a failed run shows the reason (test-run-cause.mjs);
 * - unless SFlow settled another installed Node for this Story's tests (node-version-settle.mjs, with an
 *   undo on the decisions card) [owner, 2026-11-19]: that one goes first on PATH, status `settled`, and
 *   the version file is left as it is. The settlement is kept beside the repository's Git data and
 *   counts for the Story's branch and for the detached checkouts SFlow runs its tests in.
 *
 * The file's text only chooses among the version folders of known version managers: it is read as
 * a version or not at all, and never becomes a path. A failure here never stops a run. The record
 * holds a repository path, the version asked for and versions found, never a folder on this machine.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { nodeVersion } from './test-toolchain.mjs';

export const NODE_VERSION_FILES = Object.freeze(['.nvmrc', '.node-version']);
const MAXIMUM_FILE_BYTES = 256;
const HOMEBREW_PREFIXES = Object.freeze(['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew']);
// A later LTS line is read from the name nvm keeps for it (nvmLtsMajor).
const LTS_MAJORS = Object.freeze({
  argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24
});

const valueOf = (environment, name) => environment[Object.keys(environment).find((key) => key.toUpperCase() === name) ?? name];

/** Where SFlow keeps the Nodes it settled for Stories' tests, under the repository's shared Git folder. */
export const NODE_OVERRIDES_FILE = Object.freeze(['singularity-flow', 'node-overrides.json']);

/** What a version file asks for: `{ wanted, ... }`, or null when its text names no version. */
export function parseNodeVersionRequest(text) {
  const wanted = String(text ?? '').split(/\r?\n/u).map((line) => line.replace(/#.*$/u, '').trim()).find(Boolean) ?? '';
  const numbered = /^v?(\d{1,4})(?:\.(\d{1,4}|x))?(?:\.(\d{1,4}|x))?$/iu.exec(wanted);
  if (numbered) {
    return { wanted, parts: numbered.slice(1).map((part) => (part === undefined || part.toLowerCase() === 'x' ? null : Number(part))) };
  }
  const lts = /^lts\/(\*|[a-z]{2,20})$/iu.exec(wanted);
  if (lts) return { wanted, lts: lts[1].toLowerCase(), major: LTS_MAJORS[lts[1].toLowerCase()] ?? null };
  return /^(?:node|stable)$/iu.test(wanted) ? { wanted, any: true } : null;
}

function versionParts(version) {
  return /^v?(\d+)\.(\d+)\.(\d+)/u.exec(String(version ?? ''))?.slice(1).map(Number) ?? null;
}

/** Whether a Node version is one the request accepts. */
export function nodeVersionMatches(request, version) {
  const parts = versionParts(version);
  if (!parts) return false;
  if (request.any) return true;
  if (request.lts === '*') return parts[0] >= 4 && parts[0] % 2 === 0;
  if (request.lts) return parts[0] === request.major;
  return request.parts.every((part, index) => part === null || part === parts[index]);
}

/** Where each version manager keeps its Nodes: `{ manager, root, executable }`, `executable` inside a version's folder. */
export function nodeInstallRoots(environment, { platform = process.platform, home = valueOf(environment, 'HOME') ?? os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const set = (name) => valueOf(environment, name) || null;
  if (platform === 'win32') {
    const roaming = set('APPDATA') ?? paths.join(home, 'AppData', 'Roaming');
    const local = set('LOCALAPPDATA') ?? paths.join(home, 'AppData', 'Local');
    return [
      { manager: 'nvm', root: set('NVM_HOME') ?? paths.join(roaming, 'nvm'), executable: ['node.exe'] },
      { manager: 'fnm', root: paths.join(set('FNM_DIR') ?? paths.join(roaming, 'fnm'), 'node-versions'), executable: ['installation', 'node.exe'] },
      { manager: 'volta', root: paths.join(set('VOLTA_HOME') ?? paths.join(local, 'Volta'), 'tools', 'image', 'node'), executable: ['node.exe'] }
    ];
  }
  const data = set('XDG_DATA_HOME') ?? paths.join(home, '.local', 'share');
  const fnm = set('FNM_DIR') ?? (platform === 'darwin' && !set('XDG_DATA_HOME')
    ? paths.join(home, 'Library', 'Application Support', 'fnm') : paths.join(data, 'fnm'));
  const managed = (manager, root, ...inside) => ({ manager, root, executable: [...inside, 'bin', 'node'] });
  return [
    managed('nvm', paths.join(set('NVM_DIR') ?? paths.join(home, '.nvm'), 'versions', 'node')),
    managed('fnm', paths.join(fnm, 'node-versions'), 'installation'),
    managed('volta', paths.join(set('VOLTA_HOME') ?? paths.join(home, '.volta'), 'tools', 'image', 'node')),
    managed('asdf', paths.join(set('ASDF_DATA_DIR') ?? paths.join(home, '.asdf'), 'installs', 'nodejs')),
    managed('mise', paths.join(set('MISE_DATA_DIR') ?? paths.join(data, 'mise'), 'installs', 'node')),
    managed('nodenv', paths.join(set('NODENV_ROOT') ?? paths.join(home, '.nodenv'), 'versions')),
    managed('n', paths.join(set('N_PREFIX') ?? '/usr/local', 'n', 'versions', 'node'))
  ];
}

const isFile = (file) => stat(file).then((entry) => entry.isFile(), () => false);

/** Every Node a version manager holds here, with its version from its folder's name. */
async function installedNodes(environment, { platform, home, homebrewPrefixes }) {
  const found = [];
  await Promise.all(nodeInstallRoots(environment, { platform, home }).map(async ({ manager, root, executable }) => {
    for (const name of await readdir(root).catch(() => [])) {
      const version = /^v?(\d+\.\d+\.\d+)$/u.exec(name)?.[1];
      const file = version && path.join(root, name, ...executable);
      if (file && await isFile(file)) found.push({ manager, version, executable: file });
    }
  }));
  // Homebrew's keg-only node@22 is not on PATH; its real folder holds the version.
  await Promise.all((platform === 'win32' ? [] : homebrewPrefixes).map(async (prefix) => {
    for (const name of await readdir(path.join(prefix, 'opt')).catch(() => [])) {
      if (!/^node(?:@\d+)?$/u.test(name)) continue;
      const file = path.join(prefix, 'opt', name, 'bin', 'node');
      const version = /\/Cellar\/node(?:@\d+)?\/(\d+\.\d+\.\d+)/u.exec(await realpath(file).catch(() => ''))?.[1];
      if (version) found.push({ manager: 'Homebrew', version, executable: file });
    }
  }));
  return found;
}

const descending = (left, right) => {
  const [a, b] = [versionParts(left.version), versionParts(right.version)];
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
};

/** Each Node version a version manager or Homebrew holds here, newest first. */
export async function installedNodeVersions(environment = process.env, {
  platform = process.platform, home = valueOf(environment, 'HOME') ?? os.homedir(), homebrewPrefixes = HOMEBREW_PREFIXES
} = {}) {
  const found = await installedNodes(environment, { platform, home, homebrewPrefixes });
  return [...new Set(found.sort(descending).map((entry) => entry.version))];
}

async function nearestVersionFile(cwd, root) {
  const canonical = (folder) => realpath(folder).catch(() => path.resolve(folder));
  const [start, top] = await Promise.all([canonical(cwd), canonical(root)]);
  for (let folder = start; ;) {
    for (const name of NODE_VERSION_FILES) {
      const file = path.join(folder, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      return {
        file: path.relative(top, file).replaceAll(path.sep, '/'),
        text: info.size <= MAXIMUM_FILE_BYTES ? await readFile(file, 'utf8').catch(() => null) : null
      };
    }
    const parent = path.dirname(folder);
    const inside = path.relative(top, parent);
    if (folder === top || parent === folder || inside.startsWith('..') || path.isAbsolute(inside)) return null;
    folder = parent;
  }
}

async function nvmLtsMajor(environment, name, home) {
  const alias = await readFile(path.join(valueOf(environment, 'NVM_DIR') || path.join(home, '.nvm'), 'alias', 'lts', name), 'utf8').catch(() => null);
  return versionParts(alias?.trim())?.[0] ?? null;
}

/**
 * The checkout's own Git folders, read from its `.git` without starting Git: `{ common, head }`, or null.
 * A linked worktree's `.git` file names its own folder, whose `commondir` names the shared one.
 */
async function checkoutGitFolders(root) {
  const dotGit = path.join(root, '.git');
  const info = await stat(dotGit).catch(() => null);
  if (info?.isDirectory()) return { common: dotGit, head: path.join(dotGit, 'HEAD') };
  if (!info?.isFile() || info.size > 4096) return null;
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(await readFile(dotGit, 'utf8').catch(() => ''))?.[1];
  if (!pointer) return null;
  const own = path.resolve(root, pointer);
  const common = (await readFile(path.join(own, 'commondir'), 'utf8').catch(() => null))?.trim();
  return { common: common ? path.resolve(own, common) : own, head: path.join(own, 'HEAD') };
}

/**
 * The Node SFlow settled for a Story's tests in place of what `file` asks for (`wanted`, null when it names no version),
 * or null. It counts on the Story's branch, and in a detached checkout (an isolated or base run SFlow made of it).
 */
export async function settledNodeOverride(root, { file, wanted }) {
  const folders = await checkoutGitFolders(path.resolve(root)).catch(() => null);
  if (!folders) return null;
  const kept = await readFile(path.join(folders.common, ...NODE_OVERRIDES_FILE), 'utf8').then(JSON.parse, () => null);
  const head = (await readFile(folders.head, 'utf8').catch(() => '')).trim();
  const branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
  const matching = (Array.isArray(kept?.overrides) ? kept.overrides : []).filter((entry) => entry && entry.file === file
    && (entry.wanted ?? null) === (wanted ?? null) && /^\d{1,4}$/u.test(String(entry.version ?? '')) && (branch === null || entry.branch === branch));
  return matching.at(-1) ?? null;
}

/**
 * How a person installs Node `wanted` here: `{ manager, command }` for the first version manager this machine has
 * (nvm, fnm, Volta, asdf, mise, n, then Homebrew), else `{ manager: null, command: null }`. Reads folders only.
 */
export async function nodeInstallCommand(wanted, environment = process.env, {
  platform = process.platform, home = valueOf(environment, 'HOME') ?? os.homedir(), homebrewPrefixes = HOMEBREW_PREFIXES
} = {}) {
  const request = parseNodeVersionRequest(String(wanted ?? ''));
  const text = request?.wanted ?? null;
  const major = request?.parts?.[0] ?? request?.major ?? null;
  if (!text || request.any) return { manager: null, command: null };
  const there = (folder) => stat(folder).then((entry) => entry.isDirectory(), () => false);
  const commands = {
    nvm: `nvm install ${text}`, fnm: `fnm install ${text}`, volta: major ? `volta install node@${major}` : null,
    asdf: major ? `asdf install nodejs latest:${major}` : null, mise: major ? `mise install node@${major}` : null, n: `n install ${text}`
  };
  for (const { manager, root } of nodeInstallRoots(environment, { platform, home })) {
    if (!commands[manager]) continue;
    // nvm keeps its Nodes under versions/node once one is installed; its own folder says it is there before that.
    const folder = manager === 'nvm' && platform !== 'win32' ? path.dirname(path.dirname(root)) : manager === 'n' ? path.dirname(root) : root;
    if (await there(folder)) return { manager, command: commands[manager] };
  }
  if (major && platform !== 'win32') {
    for (const prefix of homebrewPrefixes) {
      if (await isFile(path.join(prefix, 'bin', 'brew'))) return { manager: 'Homebrew', command: `brew install node@${major}` };
    }
  }
  return { manager: null, command: null };
}

/** The highest installed Node of `major` that runs, as `{ version, manager, directory }`, or null. */
async function installedOfMajor(major, context, { environment, platform, home, homebrewPrefixes }) {
  const candidates = (await installedNodes(environment, { platform, home, homebrewPrefixes }))
    .filter((entry) => versionParts(entry.version)?.[0] === Number(major)).sort(descending);
  for (const candidate of candidates) {
    if (await nodeVersion(candidate.executable, context) === candidate.version) {
      return { version: candidate.version, manager: candidate.manager, directory: path.dirname(candidate.executable) };
    }
  }
  return null;
}

/**
 * What the nearest version file asks of this run, or null with no file. `status` is `current`,
 * `selected`, `settled`, `not-installed` or `not-a-version`; `directory` is what goes first on PATH.
 */
export async function requestedNodeVersion({
  cwd, root = cwd, environment = process.env, platform = process.platform,
  home = valueOf(environment, 'HOME') ?? os.homedir(), homebrewPrefixes = HOMEBREW_PREFIXES
} = {}) {
  const found = await nearestVersionFile(cwd, root);
  if (!found) return null;
  const context = { cwd, environment };
  const current = await nodeVersion('node', context);
  const request = found.text == null ? null : parseNodeVersionRequest(found.text);
  const machine = { environment, platform, home, homebrewPrefixes };
  // What SFlow settled for this Story's tests when the file cannot be honoured here [owner, 2026-11-19].
  const settled = async (shown) => {
    const override = await settledNodeOverride(root, shown).catch(() => null);
    if (!override) return null;
    if (current && versionParts(current)?.[0] === Number(override.version)) return { ...shown, status: 'settled', node: current, settled: override.version };
    const other = await installedOfMajor(override.version, context, machine);
    return other ? { ...shown, status: 'settled', node: other.version, manager: other.manager, directory: other.directory, settled: override.version } : null;
  };
  if (!request) return await settled({ file: found.file, wanted: null }) ?? { file: found.file, wanted: null, status: 'not-a-version', node: current };
  if (request.lts && request.lts !== '*' && request.major === null) request.major = await nvmLtsMajor(environment, request.lts, home);
  const shown = { file: found.file, wanted: request.wanted };
  if (current && nodeVersionMatches(request, current)) return { ...shown, status: 'current', node: current };
  const candidates = (await installedNodes(environment, machine))
    .filter((entry) => nodeVersionMatches(request, entry.version)).sort(descending);
  for (const candidate of candidates) {
    // Its folder says the version; only the Node itself says that it runs.
    if (await nodeVersion(candidate.executable, context) !== candidate.version) continue;
    return { ...shown, status: 'selected', node: candidate.version, manager: candidate.manager, directory: path.dirname(candidate.executable) };
  }
  return await settled(shown) ?? { ...shown, status: 'not-installed', node: current };
}

/**
 * What a person reads about this run's Node, or null when the run is what the file asks for. `install`: the command
 * nodeInstallCommand found for the version asked, when one was found.
 */
export function nodeVersionNote({ file, wanted, status, node, manager }, { install = null } = {}) {
  const ran = node ? `This run used Node ${node}.` : 'No Node was found for this run.';
  if (status === 'selected') return `Using Node ${node} from ${manager} for this run: ${file} asks for ${wanted}.`;
  if (status === 'settled') {
    return `Using Node ${node}${manager ? ` from ${manager}` : ''} for this Story's tests: ${file} ${wanted ? `asks for Node ${wanted}, which is not installed here` : 'names no Node version SFlow can read'}. `
      + 'SFlow settled it; undo it on the decisions card to choose another.';
  }
  if (status === 'not-installed') {
    return `${file} asks for Node ${wanted}, and no installed Node matches. ${ran} Install it${install?.command ? ` with ${install.manager}: ${install.command}`
      : `, for example with nvm: nvm install ${wanted}`}`;
  }
  return status === 'not-a-version' ? `${file} does not name a Node version SFlow can read. ${ran}` : null;
}

const reported = new Set();

/**
 * One run's environment with the Node its repository asks for: `environment` (a new object when it
 * changes), `nodeVersion` (the record, or null) and `explained(result)` (the stderr a failed run
 * shows, with what the run could not honour). Say each note once per process, on stderr.
 */
export async function withRequestedNode(environment, {
  cwd, root = cwd, platform = process.platform, home, homebrewPrefixes,
  report = (line) => process.stderr.write(`${line}\n`)
} = {}) {
  let requested = null;
  // Never a reason a run does not start: an unreadable answer leaves the run as it was.
  try {
    requested = await requestedNodeVersion({
      cwd, root, environment, platform, ...(home ? { home } : {}), ...(homebrewPrefixes ? { homebrewPrefixes } : {})
    });
  } catch { /* the run goes ahead on what PATH finds */ }
  if (!requested) return { environment, nodeVersion: null, explained: (result) => result.stderr };
  const { directory = null, ...nodeVersionRecord } = requested;
  const install = requested.status === 'not-installed' ? await nodeInstallCommand(requested.wanted, environment, {
    platform, ...(home ? { home } : {}), ...(homebrewPrefixes ? { homebrewPrefixes } : {}) }).catch(() => null) : null;
  const note = nodeVersionNote(nodeVersionRecord, { install });
  if (note && !reported.has(note)) { reported.add(note); report(note); }
  const unmet = requested.status === 'not-installed' || requested.status === 'not-a-version';
  const key = Object.keys(environment).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return {
    environment: directory
      ? { ...environment, [key]: [directory, environment[key]].filter(Boolean).join(platform === 'win32' ? ';' : ':') }
      : environment,
    nodeVersion: nodeVersionRecord,
    explained: (result) => (unmet && result.status !== 0 ? `${note}\n${result.stderr ?? ''}` : result.stderr)
  };
}
