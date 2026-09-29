/**
 * Where a checkout keeps its repository-wide Git storage, from the filesystem alone. `[perf]`
 *
 * `<root>/.git/...` names nothing in a linked worktree: there `.git` is a pointer file, so anything
 * written beneath it failed with ENOTDIR — silently, where the writer tolerated failure. A cache kept
 * there never hit in a Story worktree, and every command run in one paid for its lookup again.
 *
 * The pointer names the worktree-private directory, whose `commondir` names the storage the main
 * checkout and every linked worktree share. A main checkout's answer is its own `.git`, unchanged.
 *
 * This module imports nothing but Node: the product-requirement gate runs before every mutation and
 * the read model must not spawn Git, so neither may pull `git.mjs` in to answer a path question.
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The shared Git directory for `root`, or null when `root` is not a recognisable checkout. */
export function repositoryGitDirectory(root) {
  const marker = path.join(root, '.git');
  let info;
  try { info = lstatSync(marker); } catch { return null; }
  if (info.isDirectory()) return marker;
  // A pointer file is one short line. Refuse anything else rather than read an unbounded file.
  if (!info.isFile() || info.size > 4_096) return null;
  let pointer;
  try { pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/mu.exec(readFileSync(marker, 'utf8'))?.[1]; } catch { return null; }
  if (!pointer) return null;
  const worktreeDirectory = path.resolve(root, pointer);
  let common;
  try {
    common = readFileSync(path.join(worktreeDirectory, 'commondir'), 'utf8').trim();
  } catch (error) {
    // A submodule's pointer names its own complete Git directory, which has no `commondir`.
    return error?.code === 'ENOENT' ? worktreeDirectory : null;
  }
  return common ? path.resolve(worktreeDirectory, common) : null;
}

/** A path beneath the shared Git directory, falling back to `<root>/.git` for the unrecognisable. */
export function repositoryGitPath(root, ...segments) {
  return path.join(repositoryGitDirectory(root) ?? path.join(root, '.git'), ...segments);
}
