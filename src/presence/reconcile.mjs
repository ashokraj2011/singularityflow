/**
 * SF Guard's reconciliation with Git [SPEC-SFG-v1 §6, REQ-030 and REQ-031, G2]: every line the change
 * set adds or changes gets exactly one class, from the records this machine kept (G1's observed
 * writes and shell calls) settled against the declared set (§4):
 * - `declared`, `outside-workflow`, `unknown-agent`: a verified Copilot write, by its writer;
 * - `shell`: changed while a recorded shell call ran, and no write explains it;
 * - `pre-guard`: changed before SF Guard was on (or in a Story pinned before it);
 * - `unattributed`: nothing recorded explains it. A person, another tool, a script outside Copilot, a
 *   lost record or a forged one; never "person", which only a presence signature proves.
 *
 * Unverified lines (a write's arguments do not explain them) are never credited (writer-attribution).
 * Reads Git a fixed three times per request (git.mjs sfGuardChangeSet) and is bounded: a capped
 * report says it is partial, never "all declared". Allow but label: nothing reads a class to refuse.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { MANAGED_INPUTS, MANAGED_METADATA } from '../artifact-review-read.mjs';
import { attributeLineWriter } from '../comprehension/xpl2/writer-attribution.mjs';
import { sfGuardSettle } from './declared-set.mjs';

export const SF_GUARD_RECONCILE_LIMITS = Object.freeze({ files: 500, lines: 20_000, fileBytes: 1 << 20, ranges: 400 });
const SKEW_MS = 2000;
// A shell record from before G2 has no start time: the minute before it ended stands for it.
const LEGACY_SHELL_WINDOW_MS = 60_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The lines a zero-context patch adds or changes in each file: `{ path, added: [[start, end]], removed }`. */
export function parseZeroContextPatch(text) {
  const files = [];
  let file = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) { file = { path: null, added: [], removed: 0, binary: false }; files.push(file); continue; }
    if (!file) continue;
    if (line.startsWith('+++ ')) { file.path = line === '+++ /dev/null' ? null : line.slice(6); continue; }
    if (line.startsWith('Binary files ')) { file.binary = true; continue; }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      const removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
      const start = Number(hunk[2]);
      const count = hunk[3] === undefined ? 1 : Number(hunk[3]);
      file.removed += removed;
      if (count > 0) file.added.push([start, start + count - 1]);
    }
  }
  return files.filter((entry) => entry.path && !entry.binary);
}

/**
 * A published Story artifact's authored view [G3]: publication puts SFlow's metadata block (and an
 * artifact may carry approved inputs blocks) around the bytes the author wrote, so the file no longer
 * hashes to the author's recorded write. Returns `{ bytes, line(published) }` (the authored bytes,
 * whose digest is the publication's `source.sha256`, and each published line's authored line, or
 * null inside a managed block), or null when the file carries no managed block or a block does not
 * cover whole lines (then the file is read as it stands, as before).
 */
export function authoredView(text) {
  const covered = [];
  const metadata = MANAGED_METADATA.exec(text);
  if (metadata) covered.push([metadata.index, metadata.index + metadata[0].length]);
  for (const match of text.matchAll(new RegExp(MANAGED_INPUTS.source, 'gu'))) covered.push([match.index, match.index + match[0].length]);
  if (!covered.length) return null;
  covered.sort((left, right) => left[0] - right[0]);
  // Whole-line blocks only: each starts a line and ends one (at its newline, or the next line's start).
  const lineStart = (offset) => offset === 0 || text[offset - 1] === '\n';
  if (covered.some(([from, to]) => !lineStart(from) || !(to === text.length || lineStart(to) || text[to] === '\n'))) return null;
  const map = [];
  let authored = '';
  let authoredLine = 0;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/u)) {
    const from = offset;
    offset += line.length;
    let kept = '';
    for (let at = from; at < offset; at += 1) if (!covered.some(([start, stop]) => at >= start && at < stop)) kept += text[at];
    if (!kept) { map.push(null); continue; }
    authored += kept;
    authoredLine += 1;
    // A block's last line leaves only its newline: an authored blank line no published line owns.
    map.push(kept === '\n' && kept.length < line.length ? null : authoredLine);
  }
  return { bytes: Buffer.from(authored, 'utf8'), line: (published) => map[published - 1] ?? null };
}

/** The ranges `lines` (sorted `{ line, class, writer }`) make, consecutive equal labels merged. */
function ranges(file, lines) {
  const found = [];
  for (const entry of lines) {
    const last = found.at(-1);
    const label = JSON.stringify([entry.classification, entry.agent ?? null, entry.skill ?? null, entry.command ?? null, entry.continued === true]);
    if (last && last.label === label && last.end === entry.line - 1) last.end = entry.line;
    else found.push({ path: file, start: entry.line, end: entry.line, classification: entry.classification, label,
      ...(entry.agent !== undefined ? { agent: entry.agent ?? null, skill: entry.skill ?? null } : {}),
      ...(entry.continued === true ? { continued: true } : {}),
      ...(entry.command ? { command: entry.command } : {}), ...(entry.agentFilesChanged ? { agentFilesChanged: entry.agentFilesChanged } : {}) });
  }
  return found.map(({ label, ...range }) => range);
}

/** The ran shell call whose run spans `mtimeMs`, latest first, or null. */
function shellCallAt(shellRecords, mtimeMs) {
  for (const record of [...shellRecords].reverse()) {
    if (record?.ran !== true) continue;
    const ended = Date.parse(record.recordedAt);
    const started = record.startedAt ? Date.parse(record.startedAt) : ended - LEGACY_SHELL_WINDOW_MS;
    if (Number.isFinite(ended) && mtimeMs >= started - SKEW_MS && mtimeMs <= ended + SKEW_MS) return record;
  }
  return null;
}

/**
 * Classify the change set. Pure apart from `readCurrent(path)`, which returns the file's bytes and
 * mtime now (`{ bytes, mtimeMs }`, or null when absent or over the size bound).
 * `guardOnAt` is when SF Guard turned on here (ms), or null; `pinnedOff` says the Story's pin
 * predates it, so every line it holds is pre-guard unless a record says otherwise. `declaredFor`,
 * when given, returns the declared set of the Story step a record names (its `subject`), so a line an
 * earlier step wrote settles against that step's agents and skills [G3]; null falls back to `declared`.
 * `skipSubject`, when given, leaves out each line whose explaining record names a subject it accepts
 * (the whole-repository view leaves Story work to its Story [G4]); those are counted in `inStories`.
 */
export async function reconcileChangeSet({ files, readCurrent, writes = [], shellRecords = [], declared, declaredFor = null, guardOnAt = null, pinnedOff = false,
  skipSubject = null, limits = SF_GUARD_RECONCILE_LIMITS }) {
  const setFor = (subject) => (declaredFor ? declaredFor(subject) : null) ?? declared;
  const counts = Object.fromEntries(['declared', 'outside-workflow', 'unknown-agent', 'shell', 'unattributed', 'pre-guard'].map((name) => [name, 0]));
  const fileCounts = new Map();
  const found = [];
  let partial = null;
  let lines = 0;
  let removed = 0;
  let inStories = 0;
  const skipped = (subject) => Boolean(skipSubject && subject && skipSubject(subject));
  const byPath = new Map();
  for (const write of writes) for (const file of write.files ?? []) {
    if (typeof file?.path === 'string') byPath.set(file.path, [...(byPath.get(file.path) ?? []), write]);
  }
  for (const [index, file] of files.entries()) {
    if (index >= limits.files) { partial = { reason: 'files', limit: limits.files, skipped: files.length - index }; break; }
    removed += file.removed ?? 0;
    if (!file.added.length) continue;
    const current = await readCurrent(file.path);
    // A published artifact is read through its authored view: SFlow's own block lines are not classed.
    const view = current?.view ?? null;
    // Publication also ends a text artifact with a newline the author may not have written: its
    // authored digest (source.sha256) is taken before that, so the view is tried both ways, nothing else.
    const ends = view ? [view.bytes, ...(view.bytes.at(-1) === 0x0a ? [view.bytes.subarray(0, -1)] : [])].map(sha256)
      : current?.bytes ? [sha256(current.bytes)] : [];
    const end = ends[0] ?? null;
    const records = byPath.get(file.path) ?? [];
    const labelled = [];
    for (const [start, last] of file.added) {
      for (let line = start; line <= last; line += 1) {
        if (lines + inStories >= limits.lines) { partial ??= { reason: 'lines', limit: limits.lines }; break; }
        const authoredLine = view ? view.line(line) : line;
        if (authoredLine == null) continue;
        let entry = null;
        let subject = null;
        if (end && records.length) {
          let attributed = attributeLineWriter({ records, path: file.path, start: { unknown: true }, end, line: authoredLine });
          for (const other of ends.slice(1)) {
            if (attributed.status === 'attributed') break;
            attributed = attributeLineWriter({ records, path: file.path, start: { unknown: true }, end: other, line: authoredLine });
          }
          if (attributed.status === 'attributed') { subject = attributed.subject; entry = { line, ...sfGuardSettle(attributed.writer, setFor(attributed.subject)) }; }
          else if (attributed.basis === 'unverified-write') entry = { line, classification: 'unattributed' };
        }
        if (!entry && current) {
          const shell = shellCallAt(shellRecords, current.mtimeMs);
          if (shell) {
            subject = shell.subject;
            const settled = sfGuardSettle(shell.writer, setFor(shell.subject));
            entry = { line, classification: 'shell', agent: settled.agent, skill: settled.skill, command: shell.commandSha256?.slice(0, 12) ?? null };
          }
        }
        if (!entry && (pinnedOff || (guardOnAt != null && current && current.mtimeMs < guardOnAt))) entry = { line, classification: 'pre-guard' };
        entry ??= { line, classification: 'unattributed' };
        if (skipped(subject)) { inStories += 1; continue; }
        lines += 1;
        counts[entry.classification] += 1;
        labelled.push(entry);
      }
    }
    if (labelled.length) {
      fileCounts.set(file.path, labelled.length);
      found.push(...ranges(file.path, labelled));
    }
    if (partial?.reason === 'lines') break;
  }
  return {
    lines, removed, files: fileCounts.size, counts, ...(skipSubject ? { inStories } : {}),
    ranges: found.slice(0, limits.ranges), rangesOmitted: Math.max(0, found.length - limits.ranges),
    partial
  };
}

/** A file's bytes and mtime as the working tree holds them now, bounded. */
export function workingTreeReader(root, { fileBytes = SF_GUARD_RECONCILE_LIMITS.fileBytes } = {}) {
  return async (relative) => {
    const file = path.join(root, relative);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > fileBytes) return null;
    const bytes = await readFile(file);
    const view = bytes.includes('<!-- singularity-flow:') ? authoredView(bytes.toString('utf8')) : null;
    return { bytes, mtimeMs: info.mtimeMs, ...(view ? { view } : {}) };
  };
}

/** The lines of each untracked file, as added lines of a new file. */
export async function untrackedAsAdded(paths, readCurrent) {
  const files = [];
  for (const relative of paths) {
    const current = await readCurrent(relative);
    if (!current) { files.push({ path: relative, added: [], removed: 0 }); continue; }
    const text = current.bytes.toString('utf8');
    const count = text ? (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length : 0;
    files.push({ path: relative, added: count ? [[1, count]] : [], removed: 0 });
  }
  return files;
}
