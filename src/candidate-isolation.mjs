/**
 * Run verification on exactly the candidate when the worktree holds changes no plan names
 * [E2G-027, decision D9].
 *
 * Any changed file outside every code step's candidate could change what the
 * tests execute. The developer keeps it: nothing is cleaned, stashed or reset. The tests run instead
 * in a detached worktree materialized from HEAD plus every changed file some step's plan names, with
 * repository-local dependencies copied and their workspace links rebound. The application tree there must hash exactly like
 * the developer's worktree with the excluded files left out, which is the tree the generation
 * binds; when it does not, or Git cannot make the worktree, isolation is unavailable and the
 * caller refuses as before.
 */
import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applicationPathContext, isApplicationChangePath } from './application-paths.mjs';
import { outsideEveryCandidate } from './candidate-scope.mjs';
import { secureRepositoryPath } from './util.mjs';
import { addCandidateWorktree, changedFiles, ignoredDirectories, removeCandidateWorktree, untrackedFiles } from './git.mjs';

/** Dependency folders a candidate's tests read but no generation contains. Build outputs are not shared. */
const DEPENDENCY_DIRECTORIES = new Set(['node_modules', '.venv', 'venv']);

/**
 * The changed application files outside every candidate, and the changed files
 * some step's plan names. Null when the Story scopes no code candidate.
 */
export async function candidateIsolationNeed(root, config, workflow) {
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const outside = await outsideEveryCandidate(itemDirectory, workflow);
  if (!outside) return null;
  const pathContext = applicationPathContext(config, workflow);
  const untracked = new Set(untrackedFiles(root));
  const changed = changedFiles(root).filter((candidate) => isApplicationChangePath(candidate, { ...pathContext, untracked: untracked.has(candidate) }));
  return {
    excluded: changed.filter((candidate) => outside(candidate)),
    included: changed.filter((candidate) => !outside(candidate))
  };
}

async function copyDependencies(root, target, relative) {
  if (path.posix.basename(relative) !== 'node_modules') {
    throw new Error('Python virtual environments may contain editable installs and absolute paths; prepare a candidate-local environment before isolating tests');
  }
  const source = path.join(root, relative);
  const destination = path.join(target, relative);
  if (!(await lstat(source)).isDirectory()) throw new Error('a dependency root is a link; prepare candidate-local dependencies');
  // Reflink regular dependency files when supported, but never share a writable directory with
  // the original checkout. Copy links verbatim, then rebind every repository-owned link.
  await cp(source, destination, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const links = [];
  async function rebind(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await rebind(file);
      else if (entry.isSymbolicLink()) {
        const original = path.join(root, path.relative(target, file));
        const resolved = await realpath(original);
        const mapped = path.relative(root, resolved);
        if (mapped === '..' || mapped.startsWith(`..${path.sep}`) || path.isAbsolute(mapped)) {
          throw new Error('a dependency link resolves outside the repository; prepare candidate-local dependencies');
        }
        const candidate = path.join(target, mapped);
        await rm(file);
        await symlink(candidate, file, (await stat(resolved)).isDirectory() ? 'junction' : 'file');
        links.push(file);
      }
    }
  }
  await rebind(destination);
  const canonicalTarget = await realpath(target);
  for (const file of links) {
    const resolved = path.relative(canonicalTarget, await realpath(file));
    if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
      throw new Error('a rebound dependency escapes the candidate');
    }
  }
}

async function copyEntry(root, target, relative) {
  const source = path.join(root, relative);
  const destination = path.join(target, relative);
  const info = await lstat(source).catch(() => null);
  if (!info) {
    await rm(destination, { force: true });
    return true;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { force: true, recursive: true });
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return true;
  }
  if (!info.isFile()) return false;
  await copyFile(source, destination);
  return true;
}

/**
 * Materialize the candidate beside the worktree. `treeHash(directory)` is the application tree a
 * generation binds; isolation holds only when both trees hash alike. Returns `{ available: false,
 * reason }` or `{ available: true, root, dispose }`; the caller always disposes.
 */
export async function materializeCandidate(root, { included, treeHash }) {
  root = await realpath(root);
  const target = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-')));
  const unavailable = async (reason) => {
    removeCandidateWorktree(root, target);
    await rm(target, { recursive: true, force: true });
    return { available: false, reason };
  };
  if (!addCandidateWorktree(root, target, 'HEAD')) return unavailable('Git could not create a candidate worktree');
  try {
  for (const relative of included) {
    if (!(await copyEntry(root, target, relative))) return unavailable(`${relative} is neither a file nor a symbolic link`);
  }
  for (const relative of ignoredDirectories(root)) {
    if (!DEPENDENCY_DIRECTORIES.has(path.posix.basename(relative))) continue;
    const source = path.join(root, relative);
    if (!(await stat(source).catch(() => null))?.isDirectory()) continue;
    const destination = path.join(target, relative);
    if (await lstat(destination).catch(() => null)) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await copyDependencies(root, target, relative);
  }
  const [isolatedTree, boundTree] = [await treeHash(target), await treeHash(root)];
  if (isolatedTree !== boundTree) return unavailable('the candidate worktree does not reproduce the tree the generation binds');
  return {
    available: true, root: target, treeSha256: isolatedTree,
    async dispose() {
      removeCandidateWorktree(root, target);
      await rm(target, { recursive: true, force: true });
    }
  };
  } catch (error) {
    return unavailable(`candidate dependencies could not be isolated: ${error.message}`);
  }
}

/** Bring a test report the isolated run wrote back to where the parsers read it. */
export async function importIsolatedReport(isolatedCommandRoot, commandRoot, resultPath, {
  isolatedRoot = isolatedCommandRoot, repositoryRoot = commandRoot, adapter = null
} = {}) {
  if (!resultPath) return;
  isolatedRoot = await realpath(isolatedRoot);
  repositoryRoot = await realpath(repositoryRoot);
  isolatedCommandRoot = await realpath(isolatedCommandRoot);
  commandRoot = await realpath(commandRoot);
  const count = { files: 0, bytes: 0 };
  async function copyReport(source, destination, depth = 0) {
    if (depth > 8) throw new Error('Isolated report exceeds depth 8');
    // Revalidate after the runner exits: it may have replaced the report or a parent with a link.
    await secureRepositoryPath(isolatedRoot, path.relative(isolatedRoot, source), { label: 'Isolated report', mustExist: false });
    await secureRepositoryPath(repositoryRoot, path.relative(repositoryRoot, destination), { label: 'Imported report', mustExist: false });
    const info = await lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (entry.isDirectory() || (adapter === 'junit-xml' ? /\.xml$/i : adapter === 'dotnet-trx' ? /\.trx$/i : /./).test(entry.name)) {
          await copyReport(path.join(source, entry.name), path.join(destination, entry.name), depth + 1);
        }
      }
    } else if (info.isFile()) {
      count.files += 1;
      count.bytes += info.size;
      if (info.nlink !== 1 || info.size > 16 * 1024 * 1024 || count.files > 1000 || count.bytes > 64 * 1024 * 1024) throw new Error('Isolated reports exceed safe copy limits');
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else throw new Error('Isolated reports must contain only regular files and directories');
  }
  await copyReport(path.resolve(isolatedCommandRoot, resultPath), path.resolve(commandRoot, resultPath));
}
