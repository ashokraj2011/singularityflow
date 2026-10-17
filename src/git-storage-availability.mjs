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
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
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
