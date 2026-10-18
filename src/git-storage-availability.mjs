/**
 * Whether Git can read a repository's own files, asked before Git is.
 *
 * macOS keeps files in iCloud Drive (including Desktop and Documents when those folders sync) and
 * in File Provider folders under ~/Library/CloudStorage as placeholders once "Optimize Mac Storage"
 * evicts them: the size is real, no blocks are allocated, and a read waits inside the kernel until
 * the provider downloads the bytes. Git cannot time that out. It waits in read(), so the only
 * signal used to be our own deadline expiring two minutes later with "the cause is not
 * established". Seen on a workspace under ~/Documents where 392 packfiles of a blobless lead clone
 * had been evicted and iCloud was not returning them: `session open` waited 120 seconds for a
 * fetch that was blocked reading the repository's own HEAD tree, and a Git child it could no
 * longer reach kept waiting after its parent was gone.
 *
 * So before Git runs in such a folder, its Git directory is checked for placeholders (and for
 * special files such as named pipes, which block a reader the same way). Any it finds are read
 * once, in parallel, under a short deadline: the same download a Git read would start, bounded.
 * If they arrive the command continues unchanged; if not, it ends with an answer that names the
 * folder and what to do. Outside synced folders nothing is examined.
 *
 * That check names an eviction after it happened. The second half of this module keeps Git out of
 * synced folders to begin with: workspace creation refuses one, and workspace status warns about a
 * workspace already in one, on macOS (iCloud Drive, Desktop and Documents when iCloud syncs them,
 * ~/Library/CloudStorage) and on Windows (the OneDrive folders, where Known Folder Move puts
 * Desktop, Documents and Pictures).
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, SingularityFlowError } from './util.mjs';

export const GIT_STORAGE_CHECK_ENV = 'SINGULARITY_FLOW_GIT_STORAGE_CHECK';
export const GIT_STORAGE_DOWNLOAD_TIMEOUT_ENV = 'SINGULARITY_FLOW_GIT_STORAGE_DOWNLOAD_TIMEOUT_MS';
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_TIMEOUT_MS = 120_000;
// Entries examined per Git directory. Loose objects past this are not examined; packs come first.
const MAX_ENTRIES = 50_000;
const MAX_DOWNLOADS = 4_000;
const AVAILABLE_TTL_MS = 30_000;
const UNAVAILABLE_TTL_MS = 60_000;

const remembered = new Map();

/** Forget remembered answers; tests and a long-lived host that moved a folder use this. */
export function resetGitStorageAvailability() { remembered.clear(); }

/**
 * The synced folder holding `directory`, `''` when the check is forced on elsewhere, or null when
 * it does not apply. `always`/`off` override the default for other sync tools and for tests.
 */
export function cloudSyncedFolder(directory, {
  env = process.env, platform = process.platform, homeDirectory = os.homedir()
} = {}) {
  const mode = String(env[GIT_STORAGE_CHECK_ENV] ?? '').trim().toLowerCase();
  if (mode === 'off') return null;
  // Windows stays opt-in: whether lstat tells an online-only OneDrive file from a local one is
  // unconfirmed (VERIFICATION.md, "Windows and OneDrive"). Forced on, the message names the folder.
  if (platform === 'win32' && mode === 'always') return syncedFolderOf(directory, { env, platform, homeDirectory })?.folder ?? '';
  if (platform !== 'darwin' || !homeDirectory) return mode === 'always' ? '' : null;
  const resolved = path.resolve(directory);
  for (const relative of ['Desktop', 'Documents', path.join('Library', 'Mobile Documents'), path.join('Library', 'CloudStorage')]) {
    const folder = path.join(homeDirectory, relative);
    if (resolved === folder || resolved.startsWith(`${folder}${path.sep}`)) return folder;
  }
  return mode === 'always' ? '' : null;
}

function readGitFile(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return null; }
}

/** The Git directory and common directory for `cwd`, found from the filesystem alone. */
export function locateGitDirectories(cwd, { env = process.env } = {}) {
  let gitDirectory = null;
  let worktree = null;
  if (env.GIT_DIR) gitDirectory = path.resolve(cwd, env.GIT_DIR);
  for (let directory = path.resolve(cwd); !gitDirectory; directory = path.dirname(directory)) {
    const dotGit = path.join(directory, '.git');
    let stat = null;
    try { stat = lstatSync(dotGit); } catch { /* keep walking */ }
    if (stat?.isDirectory()) { gitDirectory = dotGit; worktree = directory; }
    else if (stat?.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readGitFile(dotGit) ?? '')?.[1];
      if (pointer) { gitDirectory = path.resolve(directory, pointer.trim()); worktree = directory; }
    } else {
      try {
        if (lstatSync(path.join(directory, 'objects')).isDirectory() && lstatSync(path.join(directory, 'HEAD')).isFile()) gitDirectory = directory;
      } catch { /* not a bare repository */ }
    }
    if (!gitDirectory && path.dirname(directory) === directory) return null;
  }
  const common = readGitFile(path.join(gitDirectory, 'commondir'));
  return Object.freeze({
    gitDirectory, worktree,
    commonDirectory: common ? path.resolve(gitDirectory, common) : gitDirectory
  });
}

/**
 * Files Git may need that cannot be read now: placeholders (size, but no allocated blocks) and
 * special files. Only lstat is used, which never starts a download.
 */
export function unreadableGitFiles({ gitDirectory, commonDirectory }, {
  lstat = lstatSync, readdir = readdirSync, maxEntries = MAX_ENTRIES
} = {}) {
  const placeholders = [];
  const special = [];
  let examined = 0;
  let truncated = false;
  const visit = (file, stat, objectStore) => {
    if (stat.isFile()) {
      if (stat.size > 0 && stat.blocks === 0) placeholders.push(file);
    } else if (!stat.isDirectory() && !stat.isSymbolicLink() && objectStore) special.push(file);
  };
  const walk = (directory, objectStore, skip = new Set()) => {
    let entries;
    try { entries = readdir(directory, { withFileTypes: true }); } catch { return; }
    // Packs, indexes and refs before loose objects, so a bounded walk sees what Git opens first.
    entries.sort((left, right) => Number(/^[0-9a-f]{2}$/.test(left.name)) - Number(/^[0-9a-f]{2}$/.test(right.name)));
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      if (examined >= maxEntries) { truncated = true; return; }
      examined += 1;
      const file = path.join(directory, entry.name);
      let stat;
      try { stat = lstat(file); } catch { continue; }
      visit(file, stat, objectStore);
      if (stat.isDirectory()) walk(file, objectStore || ['objects', 'refs'].includes(entry.name));
    }
  };
  walk(commonDirectory, false, new Set(['worktrees']));
  if (gitDirectory !== commonDirectory) walk(gitDirectory, false);
  return Object.freeze({ placeholders, special, examined, truncated });
}

// Reads one byte of every listed file at once: a placeholder downloads whole on first read.
const DOWNLOAD_SCRIPT = `
const fs = require('node:fs/promises');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const files = JSON.parse(input);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const handle = await fs.open(file, 'r');
      try { await handle.read(Buffer.alloc(1), 0, 1, 0); } finally { await handle.close(); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, worker));
});`;

/** Ask for the bytes once, bounded. A child process, because a blocked read cannot be cancelled in-process. */
export function downloadGitFiles(files, {
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS, runCommand = run, execPath = process.execPath
} = {}) {
  const started = performance.now();
  const result = runCommand(execPath, ['-e', DOWNLOAD_SCRIPT], {
    input: JSON.stringify(files), timeoutMs, killSignal: 'SIGKILL', allowFailure: true, windowsHide: true,
    env: { PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '32' }
  });
  return Object.freeze({
    completed: result.status === 0 && !result.error,
    timedOut: result.timedOut === true || result.error?.code === 'ETIMEDOUT' || (result.signal === 'SIGKILL' && result.status === null),
    elapsedMs: Math.round(performance.now() - started)
  });
}

function downloadTimeout(env) {
  const value = Number(env[GIT_STORAGE_DOWNLOAD_TIMEOUT_ENV]);
  return Number.isFinite(value) && value > 0 ? Math.min(MAX_DOWNLOAD_TIMEOUT_MS, Math.trunc(value)) : DEFAULT_DOWNLOAD_TIMEOUT_MS;
}

function unavailable(directories, found, attempt, timeoutMs, folder) {
  const { commonDirectory, worktree } = directories;
  const files = [...found.special, ...found.placeholders];
  const sample = files.slice(0, 3).map((file) => path.relative(commonDirectory, file).split(path.sep).join('/'));
  const repository = worktree ?? commonDirectory;
  const seconds = Math.round(timeoutMs / 100) / 10;
  const cause = found.special.length && !found.placeholders.length
    ? `${files.length} file(s) in ${commonDirectory} (for example ${sample.join(', ')}) are not regular files, and reading them did not finish within ${seconds} s. Git would block on them.`
    : `${files.length} file(s) in ${commonDirectory} (for example ${sample.join(', ')}) are cloud placeholders that this computer has not downloaded, and reading them did not finish within ${seconds} s. Git would wait on them with no limit.`;
  const remedy = found.special.length && !found.placeholders.length
    ? `Remove the special files or clone ${repository} again, then retry.`
    : `Download ${repository} and keep it downloaded (in Finder: Control-click the folder, then Download Now), or move the workspace out of ${folder || 'the synced folder'}; then retry. If the download does not start, check iCloud or the cloud-storage app first.`;
  return Object.freeze({
    code: 'GIT_STORAGE_UNAVAILABLE', classification: 'local-storage-unavailable',
    gitDirectory: commonDirectory, repository, cloudFolder: folder || null,
    files: files.length, placeholders: found.placeholders.length, special: found.special.length,
    sample, downloadTimeoutMs: timeoutMs, downloadElapsedMs: attempt.elapsedMs, downloadTimedOut: attempt.timedOut,
    advice: `Git cannot read this repository's own files: ${cause} ${remedy}`
  });
}

/**
 * null when Git can read `cwd`'s repository (or the folder is not one that evicts files), else the
 * reason it cannot. Answers are remembered briefly per Git directory, so a command that runs many
 * Git children pays for one examination and at most one bounded download.
 */
export function gitStorageUnavailable(cwd, {
  env = process.env, platform = process.platform, homeDirectory = os.homedir(), fresh = false,
  now = Date.now(), lstat = lstatSync, readdir = readdirSync, download = downloadGitFiles
} = {}) {
  let directories;
  try { directories = locateGitDirectories(cwd, { env }); } catch { return null; }
  if (!directories) return null;
  const folder = cloudSyncedFolder(directories.commonDirectory, { env, platform, homeDirectory })
    ?? cloudSyncedFolder(directories.gitDirectory, { env, platform, homeDirectory });
  if (folder === null) return null;
  const key = `${directories.commonDirectory}\0${directories.gitDirectory}`;
  const known = remembered.get(key);
  if (!fresh && known && now - known.at < (known.result ? UNAVAILABLE_TTL_MS : AVAILABLE_TTL_MS)) return known.result;
  const found = unreadableGitFiles(directories, { lstat, readdir });
  let result = null;
  if (found.placeholders.length || found.special.length) {
    const timeoutMs = downloadTimeout(env);
    const attempt = download([...found.special, ...found.placeholders].slice(0, MAX_DOWNLOADS), { timeoutMs });
    if (!attempt.completed) result = unavailable(directories, found, attempt, timeoutMs, folder);
  }
  remembered.set(key, { at: now, result });
  return result;
}

/** The refusal a command raises when it cannot continue without those files. */
export function gitStorageError(storage) {
  return new SingularityFlowError(storage.advice, {
    code: storage.code,
    details: {
      classification: storage.classification, retryable: true, gitDirectory: storage.gitDirectory,
      repository: storage.repository, cloudFolder: storage.cloudFolder, files: storage.files,
      placeholders: storage.placeholders, special: storage.special, sample: storage.sample,
      downloadTimeoutMs: storage.downloadTimeoutMs, downloadElapsedMs: storage.downloadElapsedMs
    }
  });
}

/** Refuse before Git runs in `cwd` when its repository's files cannot be read. */
export function assertGitStorageAvailable(cwd, options = {}) {
  const storage = gitStorageUnavailable(cwd, options);
  if (storage) throw gitStorageError(storage);
}

// Where a repository should not be put at all.

export const SYNCED_FOLDER_OVERRIDE = '--allow-synced-folder';
const ICLOUD_HOME_FOLDERS = Object.freeze(['Desktop', 'Documents']);
// Each OneDrive account sets one; on an office laptop the business account is OneDriveCommercial.
const ONEDRIVE_ENVIRONMENT = Object.freeze(['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']);
// Registry value names of the Known Folders that Known Folder Move redirects into OneDrive.
const KNOWN_FOLDER_VALUES = Object.freeze({ Desktop: 'Desktop', Personal: 'Documents', 'My Pictures': 'Pictures' });
const REGISTRY_TIMEOUT_MS = 3_000;
const GIT_IN_SYNCED_FOLDER = 'Git keeps a repository as thousands of small files under .git and rewrites '
  + 'them all the time, and a sync app gets in the way: it replaces files it has uploaded with online-only '
  + 'placeholders that Git has to wait for, holds files open while it uploads them so Git cannot replace '
  + 'or delete them, and keeps a conflict copy when two changes meet.';
const GIT_IN_SYNCED_FOLDER_SHORT = 'Git there can fail on online-only placeholders, files locked while they '
  + 'upload, and sync conflict copies.';

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function environmentValue(env, name, platform) {
  if (env?.[name] != null) return env[name];
  // Windows' own environment ignores case; a copied or injected one does not.
  if (platform !== 'win32' || !env) return undefined;
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

// Resolved, with no trailing separator, and case-folded: NTFS and (by default) APFS ignore case.
function comparablePath(value, platform) {
  const api = pathFor(platform);
  let resolved = api.resolve(String(value).replace(/^\\\\\?\\(?!UNC\\)/i, ''));
  if (resolved.length > api.parse(resolved).root.length) resolved = resolved.replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function contains(folder, target, platform) {
  const outer = comparablePath(folder, platform);
  const inner = comparablePath(target, platform);
  const separator = pathFor(platform).sep;
  return inner === outer || inner.startsWith(outer.endsWith(separator) ? outer : `${outer}${separator}`);
}

function cloudStorageProvider(name) {
  if (/^onedrive/i.test(name)) return 'OneDrive';
  if (/^googledrive/i.test(name)) return 'Google Drive';
  if (/^dropbox/i.test(name)) return 'Dropbox';
  if (/^box/i.test(name)) return 'Box';
  return 'a cloud-storage app';
}

/**
 * The cloud-synced folder holding `target`: `{ folder, provider, knownFolder }`, or null. Pure:
 * what the computer says (OneDrive accounts and Known Folder locations from the Windows registry,
 * which of Desktop and Documents iCloud syncs) is passed in, so each platform is testable anywhere.
 */
export function syncedFolderOf(target, {
  env = process.env, platform = process.platform, homeDirectory = os.homedir(),
  oneDriveFolders = [], knownFolders = {}, iCloudHomeFolders = ICLOUD_HOME_FOLDERS
} = {}) {
  if (!target) return null;
  const api = pathFor(platform);
  if (platform === 'win32') {
    const roots = [...ONEDRIVE_ENVIRONMENT.map((name) => environmentValue(env, name, platform)), ...oneDriveFolders]
      .map((value) => String(value ?? '').trim()).filter((value) => api.isAbsolute(value));
    // A Known Folder inside OneDrive is named as itself: "Documents" is what a person picked.
    for (const [name, location] of Object.entries(knownFolders)) {
      if (location && api.isAbsolute(location) && roots.some((root) => contains(root, location, platform))
        && contains(location, target, platform)) return { folder: api.resolve(location), provider: 'OneDrive', knownFolder: name };
    }
    const root = roots.filter((candidate) => contains(candidate, target, platform))
      .sort((left, right) => right.length - left.length)[0];
    return root ? { folder: api.resolve(root), provider: 'OneDrive', knownFolder: null } : null;
  }
  if (platform !== 'darwin' || !homeDirectory) return null;
  const iCloud = api.join(homeDirectory, 'Library', 'Mobile Documents');
  if (contains(iCloud, target, platform)) return { folder: iCloud, provider: 'iCloud Drive', knownFolder: null };
  const cloudStorage = api.join(homeDirectory, 'Library', 'CloudStorage');
  if (contains(cloudStorage, target, platform)) {
    const first = api.resolve(target).slice(cloudStorage.length + 1).split(api.sep)[0];
    return first
      ? { folder: api.join(cloudStorage, first), provider: cloudStorageProvider(first), knownFolder: null }
      : { folder: cloudStorage, provider: 'a cloud-storage app', knownFolder: null };
  }
  for (const name of iCloudHomeFolders ?? []) {
    const folder = api.join(homeDirectory, name);
    if (contains(folder, target, platform)) return { folder, provider: 'iCloud Drive', knownFolder: name };
  }
  return null;
}

/**
 * Which of Desktop and Documents iCloud syncs. "Desktop & Documents Folders" links both into
 * iCloud Drive; a link that cannot be examined (privacy controls) counts as synced.
 */
export function iCloudSyncedHomeFolders(homeDirectory = os.homedir(), { lstat = lstatSync } = {}) {
  return ICLOUD_HOME_FOLDERS.filter((name) => {
    try { return lstat(path.join(homeDirectory, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', name)).isSymbolicLink(); }
    catch (error) { return !['ENOENT', 'ENOTDIR'].includes(error?.code); }
  });
}

/** `reg query` output as `{ key, name, type, value }` rows. */
export function parseRegistryQuery(output) {
  const rows = [];
  let key = null;
  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) { key = line.trim(); continue; }
    const match = /^\s+(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/.exec(line);
    if (match && key) rows.push({ key, name: match[1].trim(), type: match[2], value: match[3].trim() });
  }
  return rows;
}

let windowsLocations = null;

/**
 * Every OneDrive account folder and the Known Folder locations Windows records for this user, from
 * two `reg query` calls bounded at 3 s each and asked once per process. A failed or slow answer
 * adds nothing: the environment variables OneDrive sets already name an office laptop's folders.
 */
export function windowsSyncedLocations({ env = process.env, runCommand = run, fresh = false } = {}) {
  const cached = runCommand === run && !fresh;
  if (cached && windowsLocations) return windowsLocations;
  const reg = path.win32.join(environmentValue(env, 'SystemRoot', 'win32') || 'C:\\Windows', 'System32', 'reg.exe');
  const query = (args) => {
    let result = null;
    try { result = runCommand(reg, ['query', ...args], { allowFailure: true, timeoutMs: REGISTRY_TIMEOUT_MS, windowsHide: true }); }
    catch { /* no answer */ }
    return result?.status === 0 ? parseRegistryQuery(result.stdout) : [];
  };
  const oneDriveFolders = query(['HKCU\\Software\\Microsoft\\OneDrive\\Accounts', '/s', '/v', 'UserFolder'])
    .filter((row) => row.name.toLowerCase() === 'userfolder' && row.value).map((row) => row.value);
  const knownFolders = {};
  for (const row of query(['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'])) {
    const name = KNOWN_FOLDER_VALUES[row.name];
    if (name) knownFolders[name] = row.value.replace(/%([^%]+)%/g, (whole, variable) => environmentValue(env, variable, 'win32') ?? whole);
  }
  const locations = Object.freeze({ oneDriveFolders, knownFolders });
  if (cached) windowsLocations = locations;
  return locations;
}

/** What this computer says about its synced folders, in the shape `syncedFolderOf` takes. */
export function syncedFolderFacts({
  env = process.env, platform = process.platform, homeDirectory = os.homedir(),
  registry = false, runCommand = run, lstat = lstatSync
} = {}) {
  if (platform === 'darwin') return { env, platform, homeDirectory, iCloudHomeFolders: iCloudSyncedHomeFolders(homeDirectory, { lstat }) };
  if (platform === 'win32' && registry) return { env, platform, homeDirectory, ...windowsSyncedLocations({ env, runCommand }) };
  return { env, platform, homeDirectory };
}

// Where a path really is: a link into a synced folder puts Git there too. A path that does not
// exist yet is its nearest existing parent's real location plus the rest.
function realLocation(target, realpath) {
  const rest = [];
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try { return path.join(realpath(current), ...rest.reverse()); } catch { /* not there yet */ }
    if (path.dirname(current) === current) return path.resolve(target);
    rest.push(path.basename(current));
  }
}

/**
 * Which `locations` (`{ subject, path, … }`) are in a cloud-synced folder, each returned with its
 * `folder`, `provider` and `knownFolder`. `facts` comes from `syncedFolderFacts` when not given.
 */
export function syncedLocations(locations, { facts = null, realpath = realpathSync.native, ...options } = {}) {
  const known = facts ?? syncedFolderFacts(options);
  const found = [];
  for (const location of locations) {
    const synced = syncedFolderOf(location.path, known)
      ?? (known.platform === process.platform ? syncedFolderOf(realLocation(location.path, realpath), known) : null);
    if (synced) found.push({ ...location, ...synced });
  }
  return found;
}

/** Where workspaces belong instead: SINGULARITY_FLOW_WORKSPACE_ROOT, else <home>/Singularity Workspaces. */
export function localWorkspaceBase(facts) {
  const configured = String(facts.env?.SINGULARITY_FLOW_WORKSPACE_ROOT ?? '').trim();
  return configured && !syncedFolderOf(configured, facts)
    ? configured : pathFor(facts.platform).join(facts.homeDirectory, 'Singularity Workspaces');
}

function homeStaysLocal(platform) {
  return platform === 'win32'
    ? 'Known Folder Move redirects only Desktop, Documents and Pictures into OneDrive, so the rest of your home folder stays on this computer.'
    : 'iCloud syncs only Desktop and Documents from your home folder, so the rest of it stays on this computer.';
}

const describeFolder = (found) => (found.knownFolder ? `${found.knownFolder} (${found.folder})` : found.folder);

/**
 * Why `found` (from `syncedLocations`) is a problem, and what to do about it: `{ message, remedy }`
 * for a planned workspace. `remedy` ends with the override.
 */
export function syncedFolderAdvice(found, facts) {
  const base = localWorkspaceBase(facts);
  const where = found.map((entry) => `${entry.path} is in ${describeFolder(entry)}, which ${entry.provider} syncs`).join('; ');
  const clone = found.some((entry) => entry.subject === 'repository');
  return {
    message: `${where.charAt(0).toUpperCase()}${where.slice(1)}. ${GIT_IN_SYNCED_FOLDER}`,
    remedy: `${clone ? `Clone the repository again under ${base} and use that clone` : `Create the workspace under ${base}`} instead `
      + `(the default; SINGULARITY_FLOW_WORKSPACE_ROOT changes it). ${homeStaysLocal(facts.platform)} `
      + `To use this folder anyway, add ${SYNCED_FOLDER_OVERRIDE}.`
  };
}

/** The refusal for creating a workspace whose Git data would live in a synced folder. */
export function syncedFolderRefusal(found, facts) {
  const { message, remedy } = syncedFolderAdvice(found, facts);
  return new SingularityFlowError(`${message} ${remedy}`, {
    code: 'WORKSPACE_SYNCED_FOLDER',
    details: {
      classification: 'cloud-synced-folder', retryable: false, locations: found,
      suggestedBase: localWorkspaceBase(facts), override: SYNCED_FOLDER_OVERRIDE
    }
  });
}

/** The warning for an existing workspace in a synced folder: there is no move, so the way out is a new one. */
export function syncedFolderWarning(found, { workspacePath, confirmation }, facts) {
  const quoted = `"${workspacePath}"`;
  return `${found.path} is in ${describeFolder(found)}, which ${found.provider} syncs. ${GIT_IN_SYNCED_FOLDER_SHORT} `
    + `A workspace cannot be moved: create a new one under ${localWorkspaceBase(facts)} from the same repository URL, `
    + `open its Stories there from the remote (/sf-session, or singularity-flow session attach <ID>), then run `
    + `singularity-flow workspace archive-status ${quoted} --fetch and `
    + `singularity-flow workspace archive ${quoted} --confirm ${confirmation} for this one.`;
}
