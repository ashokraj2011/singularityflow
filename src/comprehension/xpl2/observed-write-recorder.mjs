/**
 * Observed-write recorder [XPL2 M3], driven by the hooks an explicit SFlow Copilot turn already runs,
 * and, where SF Guard is on, by every Copilot prompt (sf-guard-recorder.mjs).
 *
 * No hook of its own: the pre-tool guard *captures* each allowed file edit before it runs (its target
 * paths, the SHA-256 of their bytes, salted hashes of their lines, and what the tool's own arguments
 * say the bytes will become: that digest and the lines it changes), and the next pre-tool call of the
 * session, or the turn's next prompt or end, *settles* it by reading the files again. A write keeps
 * only the lines its before and after bytes differ in: the lines the arguments explain exactly are
 * verified, any other changed line is kept unverified so it can never be credited. A record keeps
 * paths, digests, line ranges, the turn and the HEAD commit it was made on; never content, arguments
 * or commands. Line hashes live only in the pending note, which settling deletes.
 *
 * Fail-safe and small: callers swallow every error, nothing is printed, no Git process runs. The hook
 * bundle loads this file from source so its chunks (and their byte ceilings) do not carry it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// @3: a writer may be a plain Copilot prompt (`copilot-session`) and carry SF Guard's `attribution`
// [SPEC-SFG-v1 REQ-020]; @2 records read the same.
const FORMAT = 'xpl2-observed-write@3';
const READ_FORMATS = Object.freeze(['xpl2-observed-write@2', FORMAT]);
const LIMIT = Object.freeze({
  files: 32, fileBytes: 1 << 20, steps: 32, segmentBytes: 1 << 20, retentionDays: 14,
  pendingBytes: 4 << 20, pendingMs: 30 * 60 * 1000, diffCells: 1_000_000
});
export { FORMAT as XPL2_OBSERVED_WRITE_FORMAT, READ_FORMATS as XPL2_OBSERVED_WRITE_READ_FORMATS, LIMIT as XPL2_OBSERVED_WRITE_LIMITS };

const DAY = 864e5;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const str = (value) => (typeof value === 'string' ? value : null);
const split = (text) => (text ? (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n') : []);

export function xpl2ObservedWriteDirectory(gitDirectory) {
  return path.join(gitDirectory, 'singularity-flow', 'xpl2', 'observed-writes');
}

/** One call's file operations in its own order: replacements, inserts, whole files, deletions, or unchecked. */
function operations(name, args, targets) {
  const file = str(args.path) ?? str(args.filePath) ?? str(args.file_path);
  const swap = (entry) => {
    const target = str(entry?.path) ?? str(entry?.filePath) ?? str(entry?.file_path);
    const old = str(entry?.old_str) ?? str(entry?.oldString) ?? str(entry?.old_string);
    const next = str(entry?.new_str) ?? str(entry?.newString) ?? str(entry?.new_string);
    return target && old != null && next != null ? { path: target, old, next } : { path: target, unchecked: true };
  };
  // The guard names a str_replace_editor call 'edit'; its create and insert forms are recognized too.
  if (['create', 'create_file', 'write_file'].includes(name) || (name === 'edit' && args.command === 'create')) {
    return [{ path: file, content: str(args.file_text) ?? str(args.content) }];
  }
  if (name === 'edit' && args.command === 'insert' && Number.isSafeInteger(args.insert_line)) {
    return [{ path: file, insert: args.insert_line, next: str(args.new_str) ?? '' }];
  }
  if (['edit', 'str_replace', 'replace_string_in_file'].includes(name) && (!args.command || args.command === 'str_replace')) return [swap(args)];
  if (name === 'multi_replace_string_in_file' && Array.isArray(args.replacements)) return args.replacements.map(swap);
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
      if (header?.[1] === 'Delete') found.push({ path: header[2].trim(), remove: true });
      file = header && header[1] !== 'Delete' ? { path: header[2].trim(), add: header[1] === 'Add' ? [] : null, update: header[1] === 'Update' } : null;
    } else if (file?.add && line.startsWith('+')) file.add.push(line.slice(1));
    else if (file?.update && line.startsWith('@@')) { const previous = file; close(); file = previous; hunk = []; }
    else if (file?.update && line !== '*** End of File') (hunk ??= []).push(line || ' ');
  }
  close();
  return found;
}

/** The one place `needle` occurs (at a line start for whole-line hunks), or -1 for none or several. */
function onePlace(text, needle, whole) {
  const places = [];
  for (let at = text.indexOf(needle); at >= 0 && places.length < 2; at = text.indexOf(needle, at + 1)) {
    if (!whole || !at || text[at - 1] === '\n') places.push(at);
  }
  return places.length === 1 ? places[0] : -1;
}

/**
 * What the tool's arguments say the file becomes: its text, `null` for absent, or `undefined` when
 * they do not determine it. A replacement must match exactly once, as the tools require; in a CRLF
 * file, arguments written with LF line ends are matched as CRLF.
 */
function expected(text, list) {
  let current = text;
  for (const op of list) {
    if (op.unchecked) return undefined;
    if (op.remove) { current = null; continue; }
    if ('content' in op) { current = op.content ?? undefined; if (current === undefined) return undefined; continue; }
    if (current == null) return undefined;
    if ('insert' in op) {
      const lines = current.split('\n');
      const body = op.next.endsWith('\n') ? op.next.slice(0, -1) : op.next;
      if (op.insert < 0 || op.insert > lines.length) return undefined;
      lines.splice(op.insert, 0, ...body.split('\n'));
      current = lines.join('\n');
      continue;
    }
    let { old, next } = op;
    if (!old) return undefined;
    let at = onePlace(current, old, op.whole);
    if (at < 0 && current.includes('\r\n') && old.includes('\n') && !old.includes('\r')) {
      [old, next] = [old.replaceAll('\n', '\r\n'), next.replaceAll('\n', '\r\n')];
      at = onePlace(current, old, op.whole);
    }
    if (at < 0) return undefined;
    current = current.slice(0, at) + next + current.slice(at + old.length);
  }
  return current;
}

/**
 * The lines two versions differ in, as `[beforeStart, beforeLines, afterStart, afterLines]` hunks
 * (1-based), from a longest-common-subsequence over the lines between their common head and tail.
 * Past the size bound it returns null: the caller then keeps the write unverified.
 */
export function xpl2LineHunks(before, after) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const b = before.slice(head, before.length - tail);
  const a = after.slice(head, after.length - tail);
  if (!b.length && !a.length) return [];
  if (!b.length || !a.length) return [[head + 1, b.length, head + 1, a.length]];
  if (b.length * a.length > LIMIT.diffCells) return null;
  const width = a.length + 1;
  const table = new Uint32Array((b.length + 1) * width);
  for (let i = b.length - 1; i >= 0; i -= 1) {
    for (let j = a.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = b[i] === a[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const hunks = [];
  let open = null;
  const mark = (i, j, before, after) => {
    open ??= [head + i + 1, 0, head + j + 1, 0];
    open[1] += before; open[3] += after;
  };
  let [i, j] = [0, 0];
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i] === a[j]) { if (open) { hunks.push(open); open = null; } i += 1; j += 1; }
    else if (j < a.length && (i >= b.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) { mark(i, j, 0, 1); j += 1; }
    else { mark(i, j, 1, 0); i += 1; }
  }
  if (open) hunks.push(open);
  return hunks;
}

/** A repository-relative path, or null outside the checkout or inside Git's directory. */
async function relative(root, cwd, target) {
  if (!target || target.includes('\0')) return null;
  const absolute = path.resolve(cwd, target);
  const directory = await realpath(path.dirname(absolute)).catch(() => null);
  const value = directory && path.relative(root, path.join(directory, path.basename(absolute)));
  return value && !value.startsWith('..') && !path.isAbsolute(value) && !/^\.git(?:[\\/]|$)/iu.test(value) ? value.split(path.sep).join('/') : null;
}

/** The file's bytes, or null when absent; anything else (a link, a directory, too large) is unreadable. */
async function bytesOf(file) {
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.size > LIMIT.fileBytes) throw new Error('unreadable');
  return readFile(file);
}

/** The HEAD commit and branch of a checkout, from its own files (no Git process). */
async function headOf(gitDirectory) {
  const head = (await readFile(path.join(gitDirectory, 'HEAD'), 'utf8')).trim();
  if (/^[0-9a-f]{40,64}$/u.test(head)) return { head, branch: null };
  const ref = /^ref: (refs\/\S+)$/u.exec(head)?.[1];
  if (!ref) return { head: null, branch: null };
  const common = path.resolve(gitDirectory, (await readFile(path.join(gitDirectory, 'commondir'), 'utf8').catch(() => '.')).trim());
  const loose = (await readFile(path.join(common, ref), 'utf8').catch(() => '')).trim();
  const packed = loose || ((await readFile(path.join(common, 'packed-refs'), 'utf8').catch(() => ''))
    .split('\n').find((line) => line.endsWith(` ${ref}`)) ?? '').split(' ')[0];
  return { head: /^[0-9a-f]{40,64}$/u.test(packed) ? packed : null, branch: ref.replace(/^refs\/heads\//u, '') };
}

async function readPending(file) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > LIMIT.pendingBytes) return null;
  const value = JSON.parse(await readFile(file, 'utf8'));
  return READ_FORMATS.includes(value?.format) && Array.isArray(value.entries) ? value : null;
}

async function writePending(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

/**
 * Note what an allowed edit is about to change, before it runs. `calls` are the guard's normalized
 * `{ name, args, targets }`; `writer`, `subject` and `gitDirectory` come from the turn's record.
 */
export async function captureToolWrites({ pendingFile, root, cwd = root, calls = [], writer, subject = null, gitDirectory, now = Date.now() }) {
  const repo = await realpath(root);
  const existing = await readPending(pendingFile).catch(() => null);
  const pending = existing?.writer?.turn === writer?.turn ? existing : {
    format: FORMAT, writer, subject, gitDirectory, root: repo, salt: randomUUID(), ...(await headOf(gitDirectory).catch(() => ({ head: null, branch: null }))), entries: []
  };
  const salted = (line) => hash(`${pending.salt}\n${line}`).slice(0, 16);
  for (const call of calls) {
    const byPath = new Map();
    for (const op of operations(call.name, call.args ?? {}, call.targets ?? [])) {
      const file = await relative(repo, call.args?.cwd ?? cwd, op.path);
      if (file && byPath.size < LIMIT.files) byPath.set(file, [...(byPath.get(file) ?? []), op]);
    }
    const id = randomUUID();
    for (const [file, list] of byPath) {
      let bytes;
      try { bytes = await bytesOf(path.join(repo, file)); } catch { continue; }
      const text = bytes ? bytes.toString('utf8') : null;
      const textual = !bytes || Buffer.from(text).equals(bytes);
      const result = textual && list.length <= LIMIT.steps ? expected(text, list) : undefined;
      const hunks = result === undefined ? null : xpl2LineHunks(split(text ?? ''), split(result ?? ''));
      pending.entries.push({
        call: id, tool: call.name, path: file, capturedAt: now,
        before: bytes ? hash(bytes) : 'absent',
        expected: hunks ? (result === null ? 'absent' : hash(Buffer.from(result))) : null,
        steps: hunks,
        lines: textual ? split(text ?? '').map(salted) : null
      });
    }
  }
  if (pending.entries.length) await writePending(pendingFile, pending);
}

/**
 * Read the files a pending note names again and record each write that changed them. An unchanged
 * file stays pending (its tool may not have run yet) until `final` or the note's age bound.
 */
export async function settleToolWrites(pendingFile, { final = false, now = Date.now() } = {}) {
  const pending = await readPending(pendingFile).catch(() => null);
  if (!pending) { await unlink(pendingFile).catch(() => {}); return; }
  const salted = (line) => hash(`${pending.salt}\n${line}`).slice(0, 16);
  const keep = [];
  const calls = new Map();
  for (const entry of pending.entries) {
    let bytes;
    try { bytes = await bytesOf(path.join(pending.root, entry.path)); } catch { continue; }
    const after = bytes ? hash(bytes) : 'absent';
    if (after === entry.before) {
      if (!final && now - entry.capturedAt < LIMIT.pendingMs) keep.push(entry);
      continue;
    }
    let file;
    if (after === entry.expected) file = { path: entry.path, verified: true, before: entry.before, after, steps: entry.steps };
    else {
      // Bytes the arguments do not explain: keep exactly which lines changed, all of them unverified.
      const text = bytes?.toString('utf8') ?? '';
      const hunks = entry.lines && (!bytes || Buffer.from(text).equals(bytes))
        ? xpl2LineHunks(entry.lines, split(text).map(salted)) : null;
      file = { path: entry.path, verified: false, before: entry.before, after, steps: hunks ?? [[1, entry.lines?.length ?? 0, 1, split(text).length]] };
    }
    calls.set(entry.call, [...(calls.get(entry.call) ?? []), { tool: entry.tool, file }]);
  }
  for (const list of calls.values()) {
    await recordObservedWrite(pending.gitDirectory, {
      source: 'copilot-hook', tool: list[0].tool, writer: pending.writer, subject: pending.subject,
      head: pending.head, branch: pending.branch, files: list.map((entry) => entry.file)
    }, { now });
  }
  if (keep.length) await writePending(pendingFile, { ...pending, entries: keep });
  else await unlink(pendingFile).catch(() => {});
}

/**
 * Append one record to today's segment (UTC). Bounded and best effort: a full segment drops the
 * record and leaves a marker (created exclusively, never through a link) so explanations say records
 * are missing; a new day prunes old days.
 */
export async function recordObservedWrite(gitDirectory, { source, tool, writer, subject = null, head = null, branch = null, files }, { now = Date.now() } = {}) {
  if (!files?.length) return null;
  const directory = xpl2ObservedWriteDirectory(gitDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const id = `OW-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const line = `${JSON.stringify({ kind: 'xpl2-observed-write', format: FORMAT, id, recordedAt: new Date(now).toISOString(),
    source, tool: String(tool).replace(/[^\w.,:-]/gu, '-').slice(0, 80), writer, subject, head, branch, files })}\n`;
  const segment = path.join(directory, `${day}.jsonl`);
  const existing = await lstat(segment).catch(() => null);
  if (existing && !existing.isFile()) return null;
  if ((existing?.size ?? 0) + Buffer.byteLength(line) > LIMIT.segmentBytes) {
    await open(path.join(directory, `${day}.full`), 'wx', 0o600).then((handle) => handle.close(), () => {});
    return null;
  }
  if (!existing) {
    const cutoff = new Date(now - LIMIT.retentionDays * DAY).toISOString().slice(0, 10);
    for (const name of await readdir(directory)) if (/^\d{4}-\d\d-\d\d\./u.test(name) && name.slice(0, 10) < cutoff) await unlink(path.join(directory, name)).catch(() => {});
  }
  await appendFile(segment, line, { mode: 0o600 });
  return id;
}
