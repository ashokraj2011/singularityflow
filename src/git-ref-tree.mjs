/**
 * Every file under a set of paths on one ref, in two subprocesses instead of one per file.
 *
 * ## Why this is its own module
 *
 * It began inside `ledger.mjs`, where reading a few JSON files per ref had been a temporary worktree
 * — so a read took the index lock, wrote under `.git/worktrees`, and created a branch it then
 * deleted. `ls-tree` plus `cat-file --batch` replaced that, and the same shape was needed one module
 * over: `buildRepositorySubjectIndex...FromRefs` ran `git show` once per work item per ref.
 *
 * Measured on a fixture with 12 branches and 40 Stories: 966 subprocesses for one `snapshot --json`,
 * of which 960 were the two-per-pair inner loop. The cost is branches × Stories, and neither factor
 * is small on a real portfolio — which is exactly the shape a benchmark holding one Story could not
 * see.
 *
 * Kept free of domain imports so either side can use it without dragging the other in.
 */

import { run } from './util.mjs';

/**
 * Contents keyed by repository-relative path.
 *
 * `cat-file --batch` takes its work list on stdin and answers with a header line followed by exactly
 * `size` **bytes** of content. The walk is by byte offset for that reason: treating the stream as a
 * string is correct only until an entry contains a character outside ASCII, and a work item's title
 * is the first place that stops being true.
 *
 * Returns an empty map rather than throwing when the ref or the paths do not exist. A ref that
 * carries nothing and a ref that cannot be read are the same answer to the caller — "no subjects
 * here" — and every caller already treats a missing file as absent.
 */
export function readRefTree(root, ref, pathspecs = [], { filter = null } = {}) {
  const listed = run('git',
    ['ls-tree', '-r', '-z', '--format=%(objectname) %(path)', ref, '--', ...pathspecs],
    { cwd: root, allowFailure: true });
  if (listed.status !== 0) return new Map();

  const entries = [];
  for (const line of listed.stdout.split('\0')) {
    if (!line) continue;
    const separator = line.indexOf(' ');
    if (separator < 0) continue;
    const file = line.slice(separator + 1);
    if (filter && !filter(file)) continue;
    entries.push({ oid: line.slice(0, separator), file });
  }
  if (!entries.length) return new Map();

  const batch = run('git', ['cat-file', '--batch'], {
    cwd: root,
    allowFailure: true,
    encoding: 'buffer',
    input: `${entries.map((entry) => entry.oid).join('\n')}\n`
  });
  if (batch.status !== 0) return new Map();

  const contents = new Map();
  const buffer = batch.stdout;
  let cursor = 0;
  for (const entry of entries) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline < 0) break;
    // `<oid> <type> <size>` — the size is in bytes, and is what makes this walk exact.
    const size = Number(buffer.toString('utf8', cursor, newline).trim().split(' ')[2]);
    if (!Number.isFinite(size)) break;
    const start = newline + 1;
    contents.set(entry.file, buffer.toString('utf8', start, start + size));
    // Git writes a newline after each object's contents, so the next header starts one byte later.
    cursor = start + size + 1;
  }
  return contents;
}
