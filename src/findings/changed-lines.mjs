/**
 * The lines this Story changed, from the change set's hunks [CQF:REQ-042]: what makes a finding
 * new code. Measured from the source base of the Story's first work interval, as the Story's own tag
 * lines are (delivery-evidence.mjs), so a rework or a later code step still counts the Story's whole
 * change; a file the Story added counts whole. A line a merge brought into the Story branch counts too.
 *
 * Changed-line coverage (M3) reads the same answer.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { pathPatchSince } from '../git.mjs';

const MAX_PATHS = 2_000;

/** `@@ -a,b +c,d @@` hunks → the added line ranges per path, from a zero-context patch. */
export function addedLineRanges(patch) {
  const ranges = new Map();
  let file = null;
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) file = null;
    else if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t$/u, '');
      file = target.startsWith('b/') ? target.slice(2) : null;
    } else if (file) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (!header) continue;
      const start = Number(header[1]);
      const count = header[2] == null ? 1 : Number(header[2]);
      if (count > 0) {
        if (!ranges.has(file)) ranges.set(file, []);
        ranges.get(file).push([start, start + count - 1]);
      }
    }
  }
  return ranges;
}

/** The commit the Story's change is measured from. */
export function storyChangeBase(workflow, changeSet) {
  return workflow?.workIntervals?.history?.[0]?.sourceBaseCommit ?? workflow?.workIntervals?.current?.sourceBaseCommit
    ?? changeSet?.base?.commit ?? null;
}

/**
 * Map each path the change set adds or modifies to `'all'` (added, untracked, or no base to compare)
 * or its changed `[start, end]` ranges in the working tree.
 */
export function storyChangedLines(root, workflow, changeSet) {
  const changed = new Map();
  const entries = (changeSet?.entries ?? []).filter((entry) => entry?.newPath).slice(0, MAX_PATHS);
  const base = storyChangeBase(workflow, changeSet);
  const compared = [];
  for (const entry of entries) {
    if (entry.untracked || entry.status === 'added' || !entry.oldPath || !base) changed.set(entry.newPath, 'all');
    else compared.push(entry.newPath);
  }
  if (compared.length) {
    const patch = pathPatchSince(root, base, null, compared);
    if (patch == null) for (const relative of compared) changed.set(relative, 'all');
    else for (const [relative, ranges] of addedLineRanges(patch)) changed.set(relative, ranges);
  }
  return changed;
}

/**
 * The text of `line`..`endLine` of a repository file, read once per file; null when unreadable or
 * larger than 4 MB. `.count(path)` is the file's number of lines.
 */
export function sourceLines(root) {
  const cache = new Map();
  const linesOf = (relative) => {
    if (!cache.has(relative)) {
      let lines = null;
      try {
        const absolute = path.join(root, ...relative.split('/'));
        if (statSync(absolute).size <= 4 * 1024 * 1024) lines = readFileSync(absolute, 'utf8').split(/\r?\n/u);
      } catch { /* not readable here */ }
      cache.set(relative, lines);
    }
    return cache.get(relative);
  };
  const text = (relative, line, endLine = line) => {
    if (!relative || !Number.isInteger(line)) return null;
    const lines = linesOf(relative);
    if (!lines || line > lines.length) return null;
    return lines.slice(line - 1, Math.min(lines.length, endLine ?? line, line + 19)).join('\n');
  };
  text.count = (relative) => linesOf(relative)?.length ?? 0;
  return text;
}
