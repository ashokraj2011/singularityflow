/**
 * Observed-write recorder [XPL2 M3], run by the post-tool hook of an explicit SFlow Copilot turn.
 *
 * A completed file tool call is kept as what its own arguments and the file's bytes right after it
 * show. It is *verified* only when the arguments explain the bytes exactly: a whole-file write equal
 * to the file, or swaps that, undone on the file last first (each at its one place), give the
 * bytes before them. A record keeps paths, SHA-256 digests and changed line ranges; never content,
 * arguments or commands. Anything else is kept unverified. Kept small: this loads on the hook path.
 * `observed-writes.mjs` reads the store and `writer-attribution.mjs` chains records by digest.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Short local names: this module is counted in the hook chunk's byte ceiling.
const FORMAT = 'xpl2-observed-write@1';
const LIMIT = Object.freeze({ files: 32, fileBytes: 1 << 20, steps: 32, segmentBytes: 1 << 20, retentionDays: 14 });
export { FORMAT as XPL2_OBSERVED_WRITE_FORMAT, LIMIT as XPL2_OBSERVED_WRITE_LIMITS };
const DAY = 864e5;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const str = (value) => (typeof value === 'string' ? value : null);
const lines = (text) => (text ? (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n') : []);

export function xpl2ObservedWriteDirectory(gitDirectory) {
  return path.join(gitDirectory, 'singularity-flow', 'xpl2', 'observed-writes');
}

/** One call's file ops in its own order: swaps, whole-file writes, or unchecked. */
function ops(name, args, targets) {
  const file = str(args.path) ?? str(args.filePath);
  const swap = (target, old, next) => (target && old != null && next != null ? { path: target, old, next } : { path: target, unchecked: true });
  const pick = (entry) => swap(str(entry?.path) ?? str(entry?.filePath),
    str(entry?.old_str) ?? str(entry?.oldString), str(entry?.new_str) ?? str(entry?.newString));
  // The guard names a str_replace_editor call 'edit'; its create form writes a whole file.
  if (['create', 'create_file', 'write_file'].includes(name) || (name === 'edit' && args.command === 'create')) {
    return [{ path: file, content: str(args.file_text) ?? str(args.content) }];
  }
  if (['edit', 'str_replace', 'replace_string_in_file'].includes(name) && (!args.command || args.command === 'str_replace')) return [pick(args)];
  if (name === 'multi_replace_string_in_file' && Array.isArray(args.swaps)) return args.swaps.map(pick);
  const patch = str(args.patch) ?? str(args.input);
  if (name === 'apply_patch' && patch) return patchOperations(patch);
  return targets.map((target) => ({ path: target, unchecked: true }));
}

/** A V4A patch: an added file is a whole-file write, each update hunk one whole-line replacement. */
function patchOperations(patch) {
  const found = [];
  let file = null;
  let hunk = null;
  const close = () => {
    if (file?.add) found.push({ path: file.path, content: file.add.map((line) => `${line}\n`).join('') });
    if (file?.update && hunk?.some((line) => line[0] !== ' ')) {
      const keep = (mark) => hunk.filter((line) => line[0] === ' ' || line[0] === mark).map((line) => `${line.slice(1)}\n`).join('');
      found.push({ path: file.path, old: keep('-'), next: keep('+'), whole: true });
    }
    hunk = null;
  };
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/u, '');
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line);
    const moved = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (header || moved || line === '*** End Patch') {
      close();
      // Moved lines arrive from elsewhere: who wrote them is not this tool's to say.
      if (moved) { found.push({ path: moved[1].trim(), unchecked: true }); file = null; continue; }
      file = header && header[1] !== 'Delete' ? { path: header[2].trim(), add: header[1] === 'Add' ? [] : null, update: header[1] === 'Update' } : null;
    } else if (file?.add && line.startsWith('+')) file.add.push(line.slice(1));
    else if (file?.update && line.startsWith('@@')) { const previous = file; close(); file = previous; hunk = []; }
    else if (file?.update && line !== '*** End of File') (hunk ??= []).push(line || ' ');
  }
  close();
  return found;
}

/** The whole lines one replacement at `at` changed: [beforeStart, beforeLines, afterStart, afterLines]. */
function step(after, at, length, old) {
  const start = at ? after.lastIndexOf('\n', at - 1) + 1 : 0;
  for (let end = at + length; ;) {
    const a = after.slice(start, end);
    const b = after.slice(start, at) + old + after.slice(at + length, end);
    if (end >= after.length || ((!a || a.endsWith('\n')) && (!b || b.endsWith('\n')))) {
      const [x, y] = [lines(a), lines(b)];
      let head = 0;
      while (head < x.length && head < y.length && x[head] === y[head]) head += 1;
      let tail = 0;
      while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail += 1;
      const first = after.slice(0, start).split('\n').length + head;
      return [first, y.length - head - tail, first, x.length - head - tail];
    }
    const next = after.indexOf('\n', end);
    end = next < 0 ? after.length : next + 1;
  }
}

/** Undo one file's swaps on its bytes, last first; each result must sit at exactly one place. */
function undo(text, swaps) {
  const steps = [];
  for (const { old, next, whole } of [...swaps].reverse()) {
    if (old === next) continue;
    const places = [];
    for (let at = next ? text.indexOf(next) : -1; at >= 0 && places.length < 2; at = text.indexOf(next, at + 1)) {
      if (!whole || !at || text[at - 1] === '\n') places.push(at);
    }
    if (places.length !== 1) return { reason: places.length ? 'ambiguous' : 'not-found' };
    steps.unshift(step(text, places[0], next.length, old));
    text = text.slice(0, places[0]) + old + text.slice(places[0] + next.length);
  }
  return { before: text, steps };
}

/** A repo-relative path, or null outside the checkout or inside Git's directory. */
async function relative(root, cwd, target) {
  if (!target || target.includes('\0')) return null;
  const absolute = path.resolve(cwd, target);
  const directory = await realpath(path.dirname(absolute)).catch(() => null);
  const value = directory && path.relative(root, path.join(directory, path.basename(absolute)));
  return value && !value.startsWith('..') && !path.isAbsolute(value) && !/^\.git(?:[\\/]|$)/iu.test(value) ? value.split(path.sep).join('/') : null;
}

/**
 * What successful file tool calls left, file by file. `calls` are the guard's `{ name, args, targets }`.
 */
export async function observeToolWrites({ root, cwd = root, calls = [] }) {
  const repo = await realpath(root);
  const byPath = new Map();
  for (const call of calls) {
    for (const op of ops(call.name, call.args ?? {}, call.targets ?? [])) {
      const file = await relative(repo, call.args?.cwd ?? cwd, op.path);
      if (file && byPath.size <= LIMIT.files) byPath.set(file, [...(byPath.get(file) ?? []), op]);
    }
  }
  const files = [];
  for (const [file, list] of [...byPath].slice(0, LIMIT.files)) {
    const info = await lstat(path.join(repo, file)).catch(() => null);
    if (!info) continue; // deleted or never created: nothing left to match
    const skip = (reason, after = null) => files.push({ path: file, verified: false, reason, after });
    if (!info.isFile()) { skip('not-a-file'); continue; }
    if (info.size > LIMIT.fileBytes) { skip('too-large'); continue; }
    const bytes = await readFile(path.join(repo, file));
    const after = hash(bytes);
    const text = bytes.toString('utf8');
    const full = list.findLastIndex((op) => 'content' in op);
    const swaps = list.slice(full + 1);
    if (list.some((op) => op.unchecked)) { skip('unchecked', after); continue; }
    if (swaps.length > LIMIT.steps) { skip('too-many-steps', after); continue; }
    const undone = undo(text, swaps);
    if (undone.reason) { skip(undone.reason, after); continue; }
    if (full >= 0) {
      // A whole-file write anchors itself; swaps after it in the same call were undone first.
      if (undone.before !== list[full].content) skip('result-differs', after);
      else files.push({ path: file, verified: true, full: true, before: null, after, steps: [[1, 0, 1, lines(undone.before).length], ...undone.steps] });
      continue;
    }
    const before = hash(Buffer.from(undone.before));
    if (before !== after) files.push({ path: file, verified: true, full: false, before, after, steps: undone.steps });
  }
  return files;
}

/**
 * Append one record to today's segment (UTC). Bounded and best effort: a full segment drops the
 * record and leaves a marker so explanations say records are missing; a new day prunes old days.
 */
export async function recordObservedWrite(gitDirectory, { source, tool, writer, subject = null, files }, { now = Date.now() } = {}) {
  if (!files?.length) return null;
  const directory = xpl2ObservedWriteDirectory(gitDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const id = `OW-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const line = `${JSON.stringify({ kind: 'xpl2-observed-write', format: FORMAT, id, recordedAt: new Date(now).toISOString(),
    source, tool: String(tool).replace(/[^\w.,:-]/gu, '-').slice(0, 80), writer, subject, files })}\n`;
  const segment = path.join(directory, `${day}.jsonl`);
  const existing = await lstat(segment).catch(() => null);
  if (existing && !existing.isFile()) return null;
  if ((existing?.size ?? 0) + Buffer.byteLength(line) > LIMIT.segmentBytes) {
    await writeFile(path.join(directory, `${day}.full`), '', { mode: 0o600 });
    return null;
  }
  if (!existing) {
    const cutoff = new Date(now - LIMIT.retentionDays * DAY).toISOString().slice(0, 10);
    for (const name of await readdir(directory)) if (/^\d{4}-\d\d-\d\d\./u.test(name) && name.slice(0, 10) < cutoff) await unlink(path.join(directory, name)).catch(() => {});
  }
  await appendFile(segment, line, { mode: 0o600 });
  return id;
}
