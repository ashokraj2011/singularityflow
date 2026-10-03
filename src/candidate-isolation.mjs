/**
 * Run verification on exactly the candidate when the worktree holds changes no plan names
 * [E2G-027, decision D9].
 *
 * A changed file outside every code step's candidate, unless it is prose, could change what the
 * tests execute. The developer keeps it: nothing is cleaned, stashed or reset. The tests run instead
 * in a detached worktree materialized from HEAD plus every changed file some step's plan names, with
 * the repository's dependency folders linked in. The application tree there must hash exactly like
 * the developer's worktree with the excluded files left out, which is the tree the generation
 * binds; when it does not, or Git cannot make the worktree, isolation is unavailable and the
 * caller refuses as before.
 */
import { copyFile, cp, lstat, mkdir, mkdtemp, readlink, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applicationPathContext, isApplicationChangePath } from './application-paths.mjs';
import { isProse, outsideEveryCandidate } from './candidate-scope.mjs';
import { addCandidateWorktree, changedFiles, ignoredDirectories, removeCandidateWorktree, untrackedFiles } from './git.mjs';

/** Dependency folders a candidate's tests read but no generation contains. Build outputs are not shared. */
const DEPENDENCY_DIRECTORIES = new Set(['node_modules', '.venv', 'venv']);

/**
 * The changed application files outside every candidate that are not prose, and the changed files
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
    excluded: changed.filter((candidate) => outside(candidate) && !isProse(candidate)),
    included: changed.filter((candidate) => !outside(candidate))
  };
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
  const target = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-'));
  const unavailable = async (reason) => {
    removeCandidateWorktree(root, target);
    await rm(target, { recursive: true, force: true });
    return { available: false, reason };
  };
  if (!addCandidateWorktree(root, target, 'HEAD')) return unavailable('Git could not create a candidate worktree');
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
    await symlink(source, destination, 'dir');
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
}

/** Bring a test report the isolated run wrote back to where the parsers read it. */
export async function importIsolatedReport(isolatedCommandRoot, commandRoot, resultPath) {
  if (!resultPath) return;
  const source = path.resolve(isolatedCommandRoot, resultPath);
  const info = await stat(source).catch(() => null);
  if (!info) return;
  const destination = path.resolve(commandRoot, resultPath);
  await mkdir(path.dirname(destination), { recursive: true });
  if (info.isDirectory()) await cp(source, destination, { recursive: true, force: true });
  else await copyFile(source, destination);
}
