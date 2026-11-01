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

/** The ranges `lines` (sorted `{ line, class, writer }`) make, consecutive equal labels merged. */
function ranges(file, lines) {
  const found = [];
  for (const entry of lines) {
    const last = found.at(-1);
    const label = JSON.stringify([entry.classification, entry.agent ?? null, entry.skill ?? null, entry.command ?? null]);
    if (last && last.label === label && last.end === entry.line - 1) last.end = entry.line;
    else found.push({ path: file, start: entry.line, end: entry.line, classification: entry.classification, label,
      ...(entry.agent !== undefined ? { agent: entry.agent ?? null, skill: entry.skill ?? null } : {}),
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
 * predates it, so every line it holds is pre-guard unless a record says otherwise.
 */
export async function reconcileChangeSet({ files, readCurrent, writes = [], shellRecords = [], declared, guardOnAt = null, pinnedOff = false,
  limits = SF_GUARD_RECONCILE_LIMITS }) {
  const counts = Object.fromEntries(['declared', 'outside-workflow', 'unknown-agent', 'shell', 'unattributed', 'pre-guard'].map((name) => [name, 0]));
  const fileCounts = new Map();
  const found = [];
  let partial = null;
  let lines = 0;
  let removed = 0;
  const byPath = new Map();
  for (const write of writes) for (const file of write.files ?? []) {
    if (typeof file?.path === 'string') byPath.set(file.path, [...(byPath.get(file.path) ?? []), write]);
  }
  for (const [index, file] of files.entries()) {
    if (index >= limits.files) { partial = { reason: 'files', limit: limits.files, skipped: files.length - index }; break; }
    removed += file.removed ?? 0;
    if (!file.added.length) continue;
    const current = await readCurrent(file.path);
    const end = current?.bytes ? sha256(current.bytes) : null;
    const records = byPath.get(file.path) ?? [];
    const labelled = [];
    for (const [start, last] of file.added) {
      for (let line = start; line <= last; line += 1) {
        if (lines >= limits.lines) { partial ??= { reason: 'lines', limit: limits.lines }; break; }
        lines += 1;
        let entry = null;
        if (end && records.length) {
          const attributed = attributeLineWriter({ records, path: file.path, start: { unknown: true }, end, line });
          if (attributed.status === 'attributed') entry = { line, ...sfGuardSettle(attributed.writer, declared) };
          else if (attributed.basis === 'unverified-write') entry = { line, classification: 'unattributed' };
        }
        if (!entry && current) {
          const shell = shellCallAt(shellRecords, current.mtimeMs);
          if (shell) {
            const settled = sfGuardSettle(shell.writer, declared);
            entry = { line, classification: 'shell', agent: settled.agent, skill: settled.skill, command: shell.commandSha256?.slice(0, 12) ?? null };
          }
        }
        if (!entry && (pinnedOff || (guardOnAt != null && current && current.mtimeMs < guardOnAt))) entry = { line, classification: 'pre-guard' };
        entry ??= { line, classification: 'unattributed' };
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
    lines, removed, files: fileCounts.size, counts,
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
    return { bytes: await readFile(file), mtimeMs: info.mtimeMs };
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
