/**
 * The index refresh a committed publication still owes, and the next command that completes it.
 *
 * A publication commits from a private index, advances the branch, then points the real index at
 * the new commit for the published files. Another program can hold `index.lock` at that moment (VS
 * Code's Git view, an editor, a terminal, a crashed Git). Failing the publication there left a
 * published commit reported as an error and every published file looking changed, so the next
 * start refused a dirty tree. Instead the publication finishes, records the commit here, and the
 * next Singularity Flow command in that checkout refreshes the index before it reads the tree.
 *
 * The record is one line, the commit ID, in the checkout's own Git directory (an index belongs to
 * one worktree); git.mjs writes it. The files to refresh are recomputed from the commit: those it changed whose index
 * entry still holds its parent's version, so nothing staged since is touched. Checking for the
 * record costs one file lookup and no Git process.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const MARKER = ['singularity-flow', 'index-refresh-pending'];
/** The completing command waits this long for the lock, not a mutation's full wait. */
const COMPLETION_LOCK_WAIT_MS = 2000;

/** The checkout's Git directory, read from disk: `.git` itself, or the directory a worktree's `.git` file names. */
function gitDirectoryOf(root) {
  const dotGit = path.join(root, '.git');
  const info = statSync(dotGit, { throwIfNoEntry: false });
  if (!info) return null;
  if (info.isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGit, 'utf8'))?.[1];
  return pointer ? path.resolve(root, pointer) : null;
}

/**
 * Complete a refresh a publication left for this checkout. Returns null when none was owed,
 * otherwise `{ status: 'refreshed' | 'superseded' | 'waiting', commit, paths? }`. While the lock is
 * still held it says so once on stderr and leaves the record for the next command.
 */
export async function completeDeferredIndexRefresh(root, { stderr = process.stderr } = {}) {
  let gitDirectory;
  try { gitDirectory = gitDirectoryOf(root); } catch { return null; }
  if (!gitDirectory) return null;
  const marker = path.join(gitDirectory, ...MARKER);
  if (!existsSync(marker)) return null;
  const commit = readFileSync(marker, 'utf8').trim();
  const { head, refreshStalePublishedIndex } = await import('./git.mjs');
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit) || head(root) !== commit) {
    // Another commit followed (or the record is unreadable): what lags behind HEAD now is
    // `recover`'s to name, by the same rule. This record no longer describes the checkout.
    rmSync(marker, { force: true });
    return { status: 'superseded', commit };
  }
  try {
    const paths = refreshStalePublishedIndex(root, commit, { lockWaitMs: COMPLETION_LOCK_WAIT_MS });
    rmSync(marker, { force: true });
    return { status: 'refreshed', commit, paths };
  } catch (error) {
    stderr.write(`Singularity Flow: published commit ${commit.slice(0, 12)} still needs its files refreshed in Git's index, `
      + `which another program is holding (${String(error.message).split('\n')[0]}). This is retried on the next command; `
      + 'the commit itself is already made.\n');
    return { status: 'waiting', commit };
  }
}
