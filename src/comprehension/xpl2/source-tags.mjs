/**
 * Bounded reader for the clause and acceptance tags in one capture's changed application files.
 *
 * Code and tests carry their links to a Story's clauses while they are being written, long before
 * a delivery record binds anything. A `@clause:<ID>` comment is the author's declaration that the
 * code below it is meant to meet that clause, usually followed by a short note on how. An
 * `@ac:<ID>` comment declares which acceptance criterion a test is for. Both use the one tag
 * grammar delivery reads (`scanSourceClauseTags`), so explanation and delivery never disagree about
 * what a comment says.
 *
 * The reader opens only the files the capture lists as changed, never the repository at large. It
 * checks each file's bytes against the content digest the change set recorded, so every tag belongs
 * to the leased capture: a file edited mid-read moves the snapshot and the whole read retries. It
 * stops at declared bounds and says so.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { clauseTagExplanation, EXPLANATION_LIMITS } from '../../implementation-bindings.mjs';
import { scanSourceClauseTags } from '../../traceability-ids.mjs';
import { secureRepositoryPath, SingularityFlowError } from '../../util.mjs';
import { xpl2Sha256 } from './model.mjs';

export const XPL2_SOURCE_TAG_LIMITS = Object.freeze({
  maximumFiles: 400,
  maximumFileBytes: 1024 * 1024,
  maximumTotalBytes: 32 * 1024 * 1024,
  maximumTags: 2_000
});

function contentDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * The after-side line numbers each file's patch adds, keyed by its after path. Hunk ranges include
 * context lines, so only the patch's own `+` lines say which lines a change wrote. A file with no
 * patch section (the diff was bounded or unavailable) has no entry: nothing is known per line.
 */
export function patchAddedLines(diff) {
  const byPath = new Map();
  if (diff?.status !== 'available' || typeof diff.patch !== 'string') return byPath;
  for (const file of diff.files ?? []) {
    if (!file?.pathAfter || !Number.isSafeInteger(file.patchStart) || !Number.isSafeInteger(file.patchEnd)) continue;
    const added = new Set();
    let line = 0;
    let before = 0;
    let after = 0;
    for (const text of diff.patch.slice(file.patchStart, file.patchEnd).split('\n')) {
      const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text);
      if (header) {
        before = Number(header[1] ?? 1);
        line = Number(header[2]);
        after = Number(header[3] ?? 1);
        continue;
      }
      // The header's counts bound the hunk, so file headers and trailing text are never read as lines.
      if (before <= 0 && after <= 0) continue;
      if (text.startsWith('+')) { added.add(line); line += 1; after -= 1; }
      else if (text.startsWith('-')) before -= 1;
      else if (!text.startsWith('\\')) { line += 1; before -= 1; after -= 1; }
      // A context line may be empty (diff.suppressBlankEmpty); "\ No newline" markers count nowhere.
    }
    byPath.set(file.pathAfter, added);
  }
  return byPath;
}

/**
 * Read the tags of every changed regular file in `changeSet` (already projected onto application
 * code). `diff` is the capture's bounded patch, which says whether a tag's line was written by this
 * change. Returns `{ status, reason, complete, counts, tags, tagsSha256 }`; each tag is
 * `{ path, line, tag: 'clause'|'ac', clauseId, note, placement }`. `note` is the text after a
 * `@clause` ID on its comment line (null when there is none, always null for `@ac`); `placement` is
 * `added` (a line this change wrote, or any line of a new untracked file), `unchanged`, or
 * `unknown` when the file has no patch to tell.
 */
export async function readChangeSourceTags(root, changeSet, diff = null, limits = XPL2_SOURCE_TAG_LIMITS) {
  const addedLines = patchAddedLines(diff);
  const candidates = (changeSet?.entries ?? []).filter((entry) => entry.newPath
    && entry.newContent?.kind === 'regular-file' && typeof entry.newContent.sha256 === 'string');
  const tags = [];
  const counts = { files: 0, skipped: 0, tags: 0 };
  let complete = true;
  let totalBytes = 0;
  for (const entry of candidates) {
    const size = Number(entry.newContent.bytes ?? 0);
    if (counts.files >= limits.maximumFiles || size > limits.maximumFileBytes
      || totalBytes + size > limits.maximumTotalBytes || tags.length >= limits.maximumTags) {
      counts.skipped += 1;
      complete = false;
      continue;
    }
    let bytes;
    try {
      const secured = await secureRepositoryPath(root, entry.newPath, {
        label: 'Changed source for clause tags', mustExist: true, type: 'file'
      });
      bytes = await readFile(secured.absolute);
    } catch {
      counts.skipped += 1;
      complete = false;
      continue;
    }
    if (contentDigest(bytes) !== entry.newContent.sha256) {
      throw new SingularityFlowError(
        'Repository changes moved while the comprehension snapshot was being read. Refresh and retry.',
        { code: 'CMP_SNAPSHOT_CHANGED' }
      );
    }
    counts.files += 1;
    totalBytes += bytes.length;
    // A binary file has no comment lines to read.
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    const found = scanSourceClauseTags(text);
    if (!found.length) continue;
    const lines = text.split(/\r?\n/u);
    for (const item of found) {
      if (tags.length >= limits.maximumTags) { complete = false; break; }
      const note = item.tag === 'clause' ? clauseTagExplanation(lines[item.line - 1], item.clauseId) : null;
      const added = addedLines.get(entry.newPath);
      tags.push({
        path: entry.newPath, line: item.line, tag: item.tag, clauseId: item.clauseId,
        note: note ? note.slice(0, EXPLANATION_LIMITS.maximum) : null,
        placement: entry.untracked === true ? 'added' : added ? (added.has(item.line) ? 'added' : 'unchanged') : 'unknown'
      });
    }
  }
  counts.tags = tags.length;
  return {
    status: candidates.length ? 'available' : 'not-applicable',
    reason: complete ? null : 'partial-inventory',
    complete,
    counts,
    tags,
    tagsSha256: candidates.length ? xpl2Sha256({ tags, complete }) : null
  };
}
