/**
 * Copy the dependency folders a checkout has installed into another checkout of its repository
 * [E2G-027, TCE:REQ-085]: the isolated run of a candidate and an Auto flight's two worktrees, which
 * start with none. Nothing is installed and no writable directory is shared.
 */
import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir, ignoredDirectories, ignoresDirectory } from './git.mjs';

/** Dependency folders a candidate's tests read but no generation contains. Build outputs are not shared. */
const DEPENDENCY_DIRECTORIES = new Set(['node_modules', '.venv', 'venv']);

/** Copy one dependency folder into place, whole or not at all; returns the links to check once every folder is there. */
async function copyDependencies(root, target, relative) {
  if (path.posix.basename(relative) !== 'node_modules') {
    throw new Error('Python virtual environments may contain editable installs and absolute paths; prepare a candidate-local environment before isolating tests');
  }
  const source = path.join(root, relative);
  const destination = path.join(target, relative);
  if (!(await lstat(source)).isDirectory()) throw new Error('a dependency root is a link; prepare candidate-local dependencies');
  // Discover links in the source, not in the copy: on Windows fs.cp can materialize a junction
  // as an ordinary directory, copying the excluded working bytes and hiding its link identity.
  // Skip all such entries during the copy, then bind them only to the candidate's own source.
  const links = [];
  const skipped = new Set();
  async function collectLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const original = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.add(path.resolve(original));
        const resolved = await realpath(original).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!resolved) continue; // A link to nothing gives the copy nothing either.
        const mapped = path.relative(root, resolved);
        if (mapped === '..' || mapped.startsWith(`..${path.sep}`) || path.isAbsolute(mapped)) {
          throw new Error('a dependency link resolves outside the repository; prepare candidate-local dependencies');
        }
        links.push({ inside: path.relative(source, original), candidate: path.join(target, mapped),
          type: (await stat(resolved)).isDirectory() ? 'junction' : 'file' });
      } else if (entry.isDirectory()) await collectLinks(original);
    }
  }
  await collectLinks(source);
  // Built beside the checkout and moved in whole, so a copy cut short is never taken for a finished one.
  const staging = await mkdtemp(path.join(path.dirname(target), '.sflow-dependencies-'));
  try {
    const built = path.join(staging, 'copy');
    // Reflink regular files where supported; no writable directory or external link is shared.
    await cp(source, built, { recursive: true, verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE, filter: file => !skipped.has(path.resolve(file)) });
    for (const { inside, candidate, type } of links) await symlink(candidate, path.join(built, inside), type);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(built, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return links.map(({ inside }) => path.join(destination, inside));
}

/**
 * Give `target`, a checkout of `root`'s repository, the dependency folders `root` has installed
 * [TCE:REQ-085]. A folder `target` already holds stays as it is. One that cannot be shared safely,
 * or that `target`'s own ignore rules would let into a commit, is left out with its reason:
 * `{ copied, refused: [{ path, reason }] }`. Links are bound to `target`'s own source, and one whose
 * package `target` does not have is dropped, as an import of it would fail either way. Another
 * repository's checkout gets nothing, whatever it happens to have installed.
 */
export async function copyRepositoryDependencies(root, target) {
  root = await realpath(root);
  target = await realpath(target);
  const result = { copied: [], refused: [] };
  if (await realpath(gitCommonDir(root)) !== await realpath(gitCommonDir(target))) return result;
  const copies = [];
  for (const relative of ignoredDirectories(root)) {
    if (!DEPENDENCY_DIRECTORIES.has(path.posix.basename(relative))) continue;
    const source = path.join(root, relative);
    if (!(await stat(source).catch(() => null))?.isDirectory()) continue;
    if (await lstat(path.join(target, relative)).catch(() => null)) continue;
    try {
      if (!ignoresDirectory(target, relative)) throw new Error('this checkout does not ignore it, so it would be committed');
      copies.push({ relative, files: await copyDependencies(root, target, relative) });
    } catch (error) {
      result.refused.push({ path: relative, reason: error.message });
    }
  }
  // Only now: a link in one folder can lead into another, which may have been copied after it.
  for (const { relative, files } of copies) {
    try {
      for (const file of files) {
        const resolved = await realpath(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!resolved) { await rm(file, { force: true }); continue; }
        const inside = path.relative(target, resolved);
        if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
          throw new Error('a rebound dependency escapes the candidate');
        }
      }
      result.copied.push(relative);
    } catch (error) {
      await rm(path.join(target, relative), { recursive: true, force: true });
      result.refused.push({ path: relative, reason: error.message });
    }
  }
  return result;
}
