/**
 * Stable, bounded, screened capture of a team directory for `workflow import-team`.
 *
 * - Explicit boundary [TAWI-REQ-001]: only the selected directory and explicit `--root`
 *   directories are read. Symbolic links are reported and never followed; nothing outside the
 *   roots is opened, and nothing is executed.
 * - Complete, stable capture [TAWI-REQ-005]: every file used as evidence is captured whole or not
 *   at all, and the whole capture is taken twice; a file or listing that changed in between is
 *   captured again once, then refused.
 * - Secrets [TAWI-REQ-006]: every text file passes the secret scan before its bytes are returned
 *   or staged. A finding withholds the file (its waiver marker is not honoured for imported
 *   content), and the blocked credential/key/session/environment paths are never opened.
 * - References [TAWI-REQ-004]: links, `#file:` paths, front-matter delegations, and exact
 *   names are resolved deterministically to resolved | ambiguous | missing | unsupported |
 *   excluded, and reference cycles are reported.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { scanText } from '../secrets.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  EXCLUDED_DIRECTORIES, TEAM_IMPORT_FORMAT_VERSION, blockedPath, describeFrontMatter, formatRole,
  recognizeFormat, sourceItemId, splitFrontMatter, textCandidate
} from './formats.mjs';

/** Default bounds; each is reported with the capture, and callers may lower or raise them. */
export const TEAM_IMPORT_BOUNDS = Object.freeze({
  files: 2000, depth: 12, fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024, pathBytes: 1024
});
const LISTED_EXCLUSIONS = 200;

function fail(code, message, details = undefined) {
  throw new SingularityFlowError(message, { code, details });
}

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** The capture path of a file: plain inside the selected directory, `+N/...` inside root N. */
export function capturePath(rootIndex, relative) {
  return rootIndex === 0 ? relative : `+${rootIndex}/${relative}`;
}

async function sourceRoot(directory, label) {
  const given = path.resolve(String(directory ?? ''));
  const info = await lstat(given).catch(() => null);
  if (!info) fail('TEAM_IMPORT_SOURCE_MISSING', `The ${label} ${given} does not exist.`);
  if (info.isSymbolicLink()) fail('TEAM_IMPORT_SOURCE_INVALID', `The ${label} ${given} is a symbolic link; name the directory it points to.`);
  if (!info.isDirectory()) fail('TEAM_IMPORT_SOURCE_INVALID', `The ${label} ${given} is not a directory.`);
  return realpath(given);
}

/** Read one regular file whole, refusing a link, a change of identity, or growth while reading. */
async function readWhole(absolute, expected) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(absolute, flags);
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expected.size || info.ino !== expected.ino) return { changed: true };
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) return { changed: true };
    return { bytes: buffer.subarray(0, info.size) };
  } catch (error) {
    if (error?.code === 'ELOOP') return { link: true };
    return { error: error?.code ?? 'read failed' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function decodeText(bytes) {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

/** One pass over every root: the listing, the readable text, and the screening of each file. */
async function capturePass(roots, bounds, textExtensions = null) {
  const files = [];
  const excluded = [];
  const contents = new Map();
  let excludedCount = 0;
  let totalBytes = 0;
  let fileCount = 0;
  const exclude = (entry) => {
    excludedCount += 1;
    if (excluded.length < LISTED_EXCLUSIONS) excluded.push(entry);
  };
  for (const [rootIndex, root] of roots.entries()) {
    const toolDirectories = new Set();
    const queue = [{ absolute: root, relative: '', depth: 0 }];
    while (queue.length) {
      const directory = queue.shift();
      const names = [];
      const handle = await opendir(directory.absolute);
      for await (const entry of handle) names.push(entry);
      names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (directory.depth === 0) {
        for (const entry of names) {
          if (entry.isDirectory() && entry.name.startsWith('.') && !['.git', '.github'].includes(entry.name)) {
            toolDirectories.add(entry.name.slice(1).toLowerCase());
          }
        }
      }
      for (const entry of names) {
        const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
        const where = capturePath(rootIndex, relative);
        if (Buffer.byteLength(where) > bounds.pathBytes) { exclude({ path: where, reason: 'path-length bound' }); continue; }
        if (entry.isSymbolicLink()) { exclude({ path: where, reason: 'symbolic link (not followed)' }); continue; }
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRECTORIES.has(entry.name)) { exclude({ path: where, reason: 'excluded directory' }); continue; }
          if (blockedPath(relative)) { exclude({ path: where, reason: 'blocked path (never read)' }); continue; }
          if (directory.depth + 1 > bounds.depth) { exclude({ path: where, reason: 'depth bound' }); continue; }
          queue.push({ absolute: path.join(directory.absolute, entry.name), relative, depth: directory.depth + 1 });
          continue;
        }
        if (!entry.isFile()) { exclude({ path: where, reason: 'not a regular file' }); continue; }
        fileCount += 1;
        if (fileCount > bounds.files) { exclude({ path: where, reason: 'file-count bound' }); continue; }
        const absolute = path.join(directory.absolute, entry.name);
        const info = await lstat(absolute);
        const format = recognizeFormat(relative, toolDirectories);
        const record = { path: where, root: rootIndex, relative, bytes: info.size, format, role: formatRole(format) };
        if (blockedPath(relative)) { files.push({ ...record, screening: 'blocked' }); continue; }
        if (!textCandidate(relative, textExtensions)) { files.push({ ...record, screening: 'not-text' }); continue; }
        if (info.size > bounds.fileBytes) { files.push({ ...record, screening: 'over-bound', bound: 'fileBytes' }); continue; }
        if (totalBytes + info.size > bounds.totalBytes) { files.push({ ...record, screening: 'over-bound', bound: 'totalBytes' }); continue; }
        const read = await readWhole(absolute, info);
        if (read.link) { exclude({ path: where, reason: 'symbolic link (not followed)' }); continue; }
        if (read.changed) { files.push({ ...record, screening: 'changed' }); continue; }
        if (read.error) { files.push({ ...record, screening: 'unreadable', reason: read.error }); continue; }
        totalBytes += read.bytes.length;
        const text = decodeText(read.bytes);
        record.sha256 = sha256(read.bytes);
        if (text === null) { files.push({ ...record, screening: 'not-text' }); continue; }
        record.lines = text.split('\n').length;
        // The waiver marker is the repository owner's statement about their own file; an imported
        // file cannot make it, so every finding withholds the file.
        const findings = scanText(text, { path: where });
        if (findings.length) {
          files.push({ ...record, screening: 'withheld',
            findings: findings.slice(0, 20).map((finding) => ({ rule: finding.rule, label: finding.label, line: finding.line })) });
          continue;
        }
        contents.set(where, text);
        files.push({ ...record, screening: 'clean' });
      }
    }
  }
  return { files, excluded, excludedCount, contents, totalBytes };
}

function passIdentity(pass) {
  return pass.files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256 ?? ''}\0${file.screening}`)
    .concat(pass.excluded.map((entry) => `!${entry.path}\0${entry.reason}`), `#${pass.excludedCount}`).join('\n');
}

function passDifference(first, second) {
  const index = (pass) => new Map(pass.files.map((file) => [file.path, `${file.bytes}\0${file.sha256 ?? ''}\0${file.screening}`]));
  const a = index(first);
  const b = index(second);
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort().slice(0, 50);
}

const LINK = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)/gu;
const FILE_REFERENCE = /#file:([^\s)\]`'"]+)/gu;
const CODE_SPAN = /`([^`\n]{1,200})`/gu;
const MENTION = /(?:^|[\s(])[@/]([a-z0-9][a-z0-9._-]{0,63})\b/gu;

function lineOf(text, index) {
  let line = 1;
  for (let cursor = text.indexOf('\n'); cursor !== -1 && cursor < index; cursor = text.indexOf('\n', cursor + 1)) line += 1;
  return line;
}

/** Resolve `target` written in `from` to a capture path inside the same root, or why not. */
function resolvePathTarget(from, target, byPath) {
  const [rootIndex, relative] = from.root === 0 ? [0, from.relative] : [from.root, from.relative];
  let clean;
  try { clean = decodeURIComponent(target.replace(/[#?].*$/u, '')); } catch { clean = target.replace(/[#?].*$/u, ''); }
  if (!clean) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(clean)) return { status: 'unsupported', reason: 'remote or scheme reference; nothing is fetched' };
  if (clean.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(clean)) return { status: 'excluded', reason: 'absolute path outside the selected roots' };
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(relative), clean.replace(/\\/gu, '/')));
  if (joined === '..' || joined.startsWith('../')) return { status: 'excluded', reason: 'outside the selected roots' };
  const where = capturePath(rootIndex, joined.replace(/\/$/u, ''));
  const file = byPath.get(where) ?? byPath.get(`${where}/SKILL.md`);
  if (!file) return { status: 'missing', target: where, reason: 'no such file in the capture' };
  if (file.screening === 'clean') return { status: 'resolved', target: file.path };
  const reasons = {
    withheld: 'withheld: the secret scan found a credential', blocked: 'blocked path (never read)',
    'over-bound': 'exceeds a capture bound', 'not-text': 'not UTF-8 text', changed: 'changed while it was read',
    unreadable: 'could not be read'
  };
  return { status: 'excluded', target: file.path, reason: reasons[file.screening] ?? file.screening };
}

function referencesOf(file, text, frontMatter, { byPath, byName }) {
  const found = [];
  const add = (reference) => found.push({ from: file.path, ...reference });
  for (const pattern of [LINK, FILE_REFERENCE]) {
    for (const match of text.matchAll(pattern)) {
      const target = match[1];
      if (target.startsWith('#')) continue;
      const resolved = resolvePathTarget(file, target, byPath);
      if (resolved) add({ kind: pattern === LINK ? 'link' : 'file', written: target.slice(0, 300), line: lineOf(text, match.index), ...resolved });
    }
  }
  for (const match of text.matchAll(CODE_SPAN)) {
    const value = match[1].trim();
    if (/^[\w./-]+\.(?:md|markdown|txt|ya?ml|json)$/iu.test(value)) {
      const resolved = resolvePathTarget(file, value, byPath);
      if (resolved?.status === 'resolved') add({ kind: 'path', written: value, line: lineOf(text, match.index), ...resolved });
      continue;
    }
    const named = byName.get(value.toLowerCase());
    if (named) add({ kind: 'name', written: value, line: lineOf(text, match.index), ...nameResolution(named, file) });
  }
  for (const match of text.matchAll(MENTION)) {
    const named = byName.get(match[1].toLowerCase());
    if (named) add({ kind: 'name', written: match[0].trim(), line: lineOf(text, match.index), ...nameResolution(named, file) });
  }
  const delegated = [frontMatter.agent, frontMatter.mode, ...(Array.isArray(frontMatter.handoffs)
    ? frontMatter.handoffs.map((entry) => entry?.agent ?? entry) : [])].filter((value) => typeof value === 'string');
  for (const value of delegated) {
    const named = byName.get(value.toLowerCase());
    if (named) add({ kind: 'metadata', written: value, line: 1, ...nameResolution(named, file) });
    else if (!['agent', 'ask', 'edit'].includes(value.toLowerCase())) {
      add({ kind: 'metadata', written: value, line: 1, status: 'missing', reason: 'no captured agent has this name' });
    }
  }
  const seen = new Set();
  return found.filter((reference) => {
    if (reference.status === 'resolved' && reference.target === file.path) return false;
    const key = `${reference.kind}\0${reference.target ?? reference.written}\0${reference.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nameResolution(named, from) {
  const others = named.filter((item) => item.path !== from.path);
  if (!others.length) return { status: 'resolved', target: from.path };
  if (others.length === 1) return { status: 'resolved', target: others[0].path };
  return { status: 'ambiguous', candidates: others.map((item) => item.path).sort(), reason: 'several captured items have this name' };
}

/** Each simple cycle among resolved file references, once, starting at its smallest path. */
function referenceCycles(references) {
  const edges = new Map();
  for (const reference of references) {
    if (reference.status !== 'resolved' || reference.target === reference.from) continue;
    if (!edges.has(reference.from)) edges.set(reference.from, new Set());
    edges.get(reference.from).add(reference.target);
  }
  const cycles = new Map();
  const visit = (node, stack, onStack) => {
    for (const next of edges.get(node) ?? []) {
      if (onStack.has(next)) {
        const cycle = stack.slice(stack.indexOf(next));
        const start = cycle.indexOf([...cycle].sort()[0]);
        const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
        cycles.set(rotated.join('\0'), [...rotated, rotated[0]]);
      } else if (stack.length < 64) {
        onStack.add(next); stack.push(next);
        visit(next, stack, onStack);
        stack.pop(); onStack.delete(next);
      }
    }
  };
  for (const node of [...edges.keys()].sort()) visit(node, [node], new Set([node]));
  return [...cycles.values()].slice(0, 50);
}

const STEP_HEADING = /^#{1,6}\s.*\b(?:steps?|phases?|workflow|process|stages?|procedure)\b/imu;

function multiStep(text) {
  const ordered = text.match(/^\s{0,3}\d{1,2}[.)]\s+\S/gmu)?.length ?? 0;
  return ordered >= 3 || STEP_HEADING.test(text);
}

/**
 * Capture `directory` (and the explicit extra `roots`) twice and return one stable capture.
 * Returns `{ capture, contents }`: the JSON-safe manifest, and the screened text of clean files.
 * `afterPass(index)` runs after each pass; tests use it to change a file between passes.
 */
export async function captureTeamDirectory(directory, { roots = [], bounds = {}, afterPass = null, textExtensions = null } = {}) {
  const limits = { ...TEAM_IMPORT_BOUNDS, ...Object.fromEntries(Object.entries(bounds).filter(([, value]) => Number.isInteger(value) && value > 0)) };
  const resolvedRoots = [await sourceRoot(directory, 'team directory')];
  for (const extra of roots) resolvedRoots.push(await sourceRoot(extra, 'extra root'));
  if (new Set(resolvedRoots).size !== resolvedRoots.length
      || resolvedRoots.some((root, index) => resolvedRoots.some((other, otherIndex) => index !== otherIndex
        && (other + path.sep).startsWith(root + path.sep)))) {
    fail('TEAM_IMPORT_SOURCE_INVALID', 'The team directory and every --root must be separate directories, none inside another.');
  }
  const pass = async (index) => {
    const result = await capturePass(resolvedRoots, limits, textExtensions);
    await afterPass?.(index);
    return result;
  };
  let first = await pass(0);
  let second = await pass(1);
  let recaptured = false;
  if (passIdentity(first) !== passIdentity(second)) {
    recaptured = true;
    first = second;
    second = await pass(2);
    if (passIdentity(first) !== passIdentity(second)) {
      fail('TEAM_IMPORT_CAPTURE_UNSTABLE', 'Files in the team directory kept changing while they were captured. Wait for edits to finish, then inspect again.',
        { changed: passDifference(first, second) });
    }
  }
  const { files, excluded, excludedCount, contents, totalBytes } = second;
  const byPath = new Map(files.map((file) => [file.path, file]));
  const items = [];
  const parsed = new Map();
  for (const file of files) {
    if (!file.format || file.screening !== 'clean') continue;
    const split = splitFrontMatter(contents.get(file.path));
    parsed.set(file.path, split);
    file.id = sourceItemId(file.relative, file.format, split.frontMatter);
    file.frontMatter = describeFrontMatter(file.format, split.frontMatter);
    if (split.problem) file.problem = split.problem;
    items.push(file);
  }
  const byName = new Map();
  for (const item of items) {
    for (const name of new Set([item.id, ...(item.frontMatter.name ? [item.frontMatter.name.toLowerCase()] : [])])) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(item);
    }
  }
  // References from every interpreted file, then from each document they reach, to a fixed point.
  const references = [];
  const scanned = new Set();
  const pending = items.map((item) => item.path);
  while (pending.length) {
    const where = pending.shift();
    if (scanned.has(where)) continue;
    scanned.add(where);
    const file = byPath.get(where);
    const text = contents.get(where);
    if (!file || text === undefined) continue;
    const found = referencesOf(file, text, parsed.get(where)?.frontMatter ?? {}, { byPath, byName });
    references.push(...found);
    for (const reference of found) {
      if (reference.status === 'resolved' && !scanned.has(reference.target)) {
        const target = byPath.get(reference.target);
        if (target && !target.format) target.kind = 'reference';
        pending.push(reference.target);
      }
    }
  }
  for (const file of files) file.kind ??= file.format ? 'interpreted' : 'other';
  const cycles = referenceCycles(references);
  const outgoing = (where) => references.filter((reference) => reference.from === where && reference.status === 'resolved'
    && byPath.get(reference.target)?.role && ['agent', 'skill', 'procedure'].includes(byPath.get(reference.target).role));
  const entryCandidates = items.filter((item) => ['agent', 'procedure'].includes(item.role)).map((item) => {
    const delegates = new Set(outgoing(item.path).map((reference) => reference.target));
    const steps = multiStep(contents.get(item.path));
    const reasons = [];
    if (delegates.size) reasons.push(`refers to ${delegates.size} other agent${delegates.size === 1 ? '' : 's'}, skill${delegates.size === 1 ? '' : 's'} or prompt${delegates.size === 1 ? '' : 's'}`);
    if (steps) reasons.push('describes ordered steps');
    return { id: item.id, path: item.path, format: item.format, score: delegates.size * 2 + (steps ? 1 : 0), reasons };
  }).filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  const manifest = {
    formatVersion: TEAM_IMPORT_FORMAT_VERSION,
    bounds: limits,
    files: files.map((file) => canonical(file)),
    excluded, excludedCount
  };
  const capture = {
    ...manifest,
    sha256: sha256(JSON.stringify(canonical({ ...manifest, files: manifest.files.map(({ frontMatter, id, problem, kind, ...rest }) => rest) }))),
    roots: resolvedRoots.map((root, index) => ({ label: index === 0 ? '.' : `+${index}`, path: root })),
    recaptured,
    totalBytes,
    references,
    cycles,
    entryCandidates
  };
  return { capture, contents };
}

/** Items a capture interprets that answer to `value`: an id, a declared name, or a capture path. */
export function matchItems(capture, value) {
  const wanted = String(value ?? '').trim();
  const lower = wanted.toLowerCase();
  return capture.files.filter((file) => file.id && (file.path === wanted || file.id === lower
    || file.frontMatter?.name?.toLowerCase() === lower));
}

/**
 * The files an interpretation of `entries` needs: the entries, every file their resolved
 * references reach, and repository-wide instruction files, which apply to every agent.
 */
export function captureClosure(capture, entries) {
  const byPath = new Map(capture.files.map((file) => [file.path, file]));
  const selected = new Set();
  const pending = [...entries];
  while (pending.length) {
    const where = pending.shift();
    if (selected.has(where) || byPath.get(where)?.screening !== 'clean') continue;
    selected.add(where);
    for (const reference of capture.references) {
      if (reference.from === where && reference.status === 'resolved') pending.push(reference.target);
    }
  }
  const ambient = capture.files.filter((file) => file.screening === 'clean'
    && ['repository-instructions', 'agents-md', 'tool-instructions'].includes(file.format) && !selected.has(file.path));
  return [...[...selected].map((where) => ({ ...byPath.get(where), ambient: false })),
    ...ambient.map((file) => ({ ...file, ambient: true }))]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
