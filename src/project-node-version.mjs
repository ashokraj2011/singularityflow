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
 *   and says so. SFlow never installs a Node, and a failed run shows the reason (test-run-cause.mjs).
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
 * What the nearest version file asks of this run, or null with no file. `status` is `current`,
 * `selected`, `not-installed` or `not-a-version`; `directory` is what goes first on PATH.
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
  if (!request) return { file: found.file, wanted: null, status: 'not-a-version', node: current };
  if (request.lts && request.lts !== '*' && request.major === null) request.major = await nvmLtsMajor(environment, request.lts, home);
  const shown = { file: found.file, wanted: request.wanted };
  if (current && nodeVersionMatches(request, current)) return { ...shown, status: 'current', node: current };
  const candidates = (await installedNodes(environment, { platform, home, homebrewPrefixes }))
    .filter((entry) => nodeVersionMatches(request, entry.version)).sort(descending);
  for (const candidate of candidates) {
    // Its folder says the version; only the Node itself says that it runs.
    if (await nodeVersion(candidate.executable, context) !== candidate.version) continue;
    return { ...shown, status: 'selected', node: candidate.version, manager: candidate.manager, directory: path.dirname(candidate.executable) };
  }
  return { ...shown, status: 'not-installed', node: current };
}

/** What a person reads about this run's Node, or null when the run is what the file asks for. */
export function nodeVersionNote({ file, wanted, status, node, manager }) {
  const ran = node ? `This run used Node ${node}.` : 'No Node was found for this run.';
  if (status === 'selected') return `Using Node ${node} from ${manager} for this run: ${file} asks for ${wanted}.`;
  if (status === 'not-installed') {
    return `${file} asks for Node ${wanted}, and no installed Node matches. ${ran} Install it with your version manager, such as: nvm install ${wanted}`;
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
  const note = nodeVersionNote(nodeVersionRecord);
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
