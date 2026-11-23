/** Bounded build-manifest reads. Links may share configuration, never escape the repository. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { posix, SingularityFlowError } from './util.mjs';

const MAX_LINKS = 32;
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function unsafe(relative, reason, cause) {
  return new SingularityFlowError(`Initialization manifest '${relative}' is unsafe: ${reason}.`, {
    code: 'INI_MANIFEST_UNSAFE', cause, details: { path: relative, reason }
  });
}

function within(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function segments(value) {
  return value.split(path.sep === '\\' ? /[\\/]+/u : /\/+/u).filter((part) => part && part !== '.');
}

function absoluteSegments(root, raw) {
  const native = path.sep === '\\' ? raw.replaceAll('/', '\\') : raw;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const compare = (value) => path.sep === '\\' ? value.toLowerCase() : value;
  if (compare(native) === compare(root)) return [];
  return compare(native).startsWith(compare(prefix)) ? segments(native.slice(prefix.length)) : null;
}

/** Validate every directory/link hop before opening anything. No external target is read. */
export async function resolveRepositoryManifest(root, relative) {
  const logicalRoot = path.resolve(root);
  const canonicalRoot = await realpath(logicalRoot);
  const initial = path.resolve(canonicalRoot, relative);
  if (!relative || path.isAbsolute(relative) || !within(canonicalRoot, initial)) throw unsafe(relative, 'path escapes the repository');
  // Keep '..' until its physical parent is known. Lexically normalizing link/../file can
  // silently read different bytes from those the build tool would read through the same link.
  let remaining = segments(relative);
  let current = canonicalRoot;
  const links = [];
  const visited = new Set();
  let info;
  while (remaining.length) {
    const component = remaining.shift();
    if (component === '..') {
      if (current === canonicalRoot) throw unsafe(relative, 'path escapes the repository');
      current = path.dirname(current);
      info = null;
      continue;
    }
    current = path.join(current, component);
    try { info = await lstat(current); }
    catch (error) {
      if (error.code === 'ENOENT' && !links.length) throw error;
      throw unsafe(relative, error.code === 'ENOENT' ? 'broken link target' : 'path cannot be inspected', error);
    }
    if (info.isSymbolicLink()) {
      if (visited.has(current) || links.length >= MAX_LINKS) throw unsafe(relative, 'link cycle or link-depth limit');
      visited.add(current);
      const raw = await readlink(current);
      let base = path.dirname(current);
      let targetSegments = segments(raw);
      // macOS commonly gives callers /var while realpath gives /private/var. Accept the
      // caller's own root alias without allowing any other outside intermediate target.
      if (path.isAbsolute(raw)) {
        targetSegments = absoluteSegments(canonicalRoot, raw) ?? absoluteSegments(logicalRoot, raw);
        if (!targetSegments) throw unsafe(relative, 'link target escapes the repository');
        base = canonicalRoot;
      }
      links.push({ path: posix(path.relative(canonicalRoot, current)),
        target: [posix(path.relative(canonicalRoot, base)), ...targetSegments].filter(Boolean).join('/'), linkSha256: sha(raw) });
      remaining = [...targetSegments, ...remaining];
      current = base;
      continue;
    }
    if (remaining.length && !info.isDirectory()) throw unsafe(relative, 'parent is not a directory');
  }
  if (!info?.isFile()) throw unsafe(relative, 'target is not a regular file');
  return { absolute: current, resolvedPath: posix(path.relative(canonicalRoot, current)), links, info };
}

export async function repositoryManifestExists(root, relative) {
  try { await resolveRepositoryManifest(root, relative); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Bind the link chain and the bytes of its regular target, with no-follow descriptor checks. */
export async function readRepositoryManifest(root, relative, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const resolved = await resolveRepositoryManifest(root, relative);
  if (resolved.info.size > maxBytes) throw new SingularityFlowError(
    `Initialization manifest exceeds the ${maxBytes}-byte file bound: ${relative}`, {
      code: 'INI_DETECTION_BOUND_EXCEEDED', details: { path: relative, bound: 'maxFileBytes', observed: resolved.info.size }
    }
  );
  let handle;
  try {
    handle = await open(resolved.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(resolved.info, before)) throw unsafe(relative, 'target changed before reading');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const probe = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat();
    const current = await resolveRepositoryManifest(root, relative);
    if (offset !== bytes.length || probe.bytesRead || !sameFile(before, after)
        || !sameFile(before, current.info) || resolved.resolvedPath !== current.resolvedPath
        || JSON.stringify(resolved.links) !== JSON.stringify(current.links)) throw unsafe(relative, 'manifest or link changed while reading');
    return { bytes, info: after, ...(resolved.links.length ? { links: resolved.links, resolvedPath: resolved.resolvedPath } : {}) };
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    throw unsafe(relative, 'target cannot be safely read', error);
  } finally { await handle?.close(); }
}
