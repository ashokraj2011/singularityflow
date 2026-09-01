/**
 * Hardened filesystem boundary for bounded private records below the Git common directory.
 *
 * This module is deliberately product-neutral. Auto and SGOS both depend on it, while translating
 * its stable storage errors into their own public vocabularies at their respective boundaries.
 */
import { constants as fsConstants } from 'node:fs';
import {
  link, lstat, mkdir, open, realpath, readdir, rename, rm
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { SingularityFlowError } from './util.mjs';

const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF']);

function fail(message, details = null) {
  throw new SingularityFlowError(message, { code: 'PRIVATE_SIDECAR_PATH_UNSAFE', details });
}

function contained(commonDirectory, target) {
  const relative = path.relative(commonDirectory, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)
        || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code))) return;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function safePrivateSidecarDirectory(root, directory, { create = false } = {}) {
  const commonDirectory = path.resolve(gitCommonDir(root));
  const targetDirectory = path.resolve(directory);
  if (!contained(commonDirectory, targetDirectory)) {
    fail('Private sidecar path escapes the Git common directory.');
  }
  let commonInfo;
  try { commonInfo = await lstat(commonDirectory); } catch (error) {
    if (error?.code === 'ENOENT') fail('Git common directory is unavailable.');
    throw error;
  }
  if (commonInfo.isSymbolicLink() || !commonInfo.isDirectory()) {
    fail('Git common directory must be a real directory.');
  }

  let cursor = commonDirectory;
  const relative = path.relative(commonDirectory, targetDirectory);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const parent = cursor;
    cursor = path.join(cursor, segment);
    let info;
    try { info = await lstat(cursor); } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(cursor, { mode: 0o700 }); } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      await syncDirectory(parent);
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`Private sidecar ancestor '${cursor}' is not a real directory.`);
    }
  }
  const canonicalCommon = await realpath(commonDirectory);
  const rebound = await realpath(targetDirectory);
  const expectedRebound = path.resolve(canonicalCommon, relative);
  if (rebound !== expectedRebound) {
    fail('Private sidecar directory changed identity during validation.');
  }
  return targetDirectory;
}

export async function readPrivateSidecar(root, target, {
  maximumBytes, optional = false, identityRetries = 3
} = {}) {
  try { await safePrivateSidecarDirectory(root, path.dirname(target)); }
  catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  let entry;
  try {
    entry = await lstat(target);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail(`Private sidecar '${target}' is not a real regular file.`);
    }
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  let handle;
  try {
    handle = await open(target,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) fail(`Private sidecar '${target}' is not a regular file.`);
    if (entry.dev !== info.dev || entry.ino !== info.ino) {
      await handle.close();
      handle = null;
      if (identityRetries > 0) {
        return readPrivateSidecar(root, target, {
          maximumBytes, optional, identityRetries: identityRetries - 1
        });
      }
      fail(`Private sidecar '${target}' changed identity while it was opened.`);
    }
    if (Number.isSafeInteger(maximumBytes) && info.size > maximumBytes) {
      throw new SingularityFlowError('Private sidecar exceeds its installed byte ceiling.', {
        code: 'PRIVATE_RECORD_SIZE_LIMIT', details: { actualBytes: info.size, maximumBytes }
      });
    }
    await safePrivateSidecarDirectory(root, path.dirname(target));
    // Mutable sidecars publish with atomic rename, so the directory entry may legitimately point
    // at the next version after this handle is open. The pre-open lstat/handle identity comparison
    // proves this handle did not follow a raced link; read that immutable inode to completion.
    let bytes;
    if (Number.isSafeInteger(maximumBytes)) {
      const bounded = Buffer.alloc(maximumBytes + 1);
      let offset = 0;
      while (offset < bounded.length) {
        const { bytesRead } = await handle.read(
          bounded, offset, bounded.length - offset, offset
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      bytes = bounded.subarray(0, offset);
    } else {
      bytes = await handle.readFile();
    }
    if (Number.isSafeInteger(maximumBytes) && bytes.length > maximumBytes) {
      throw new SingularityFlowError('Private sidecar exceeds its installed byte ceiling.', {
        code: 'PRIVATE_RECORD_SIZE_LIMIT', details: { actualBytes: bytes.length, maximumBytes }
      });
    }
    return bytes;
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail(`Private sidecar '${target}' is a symbolic link.`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Atomically replace one mutable private sidecar without following untrusted links. */
export async function writeMutablePrivateSidecar(root, target, bytes, { maximumBytes } = {}) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || content.length > maximumBytes) {
    throw new SingularityFlowError('Private sidecar exceeds its installed byte ceiling.', {
      code: 'PRIVATE_RECORD_SIZE_LIMIT',
      details: { actualBytes: content.length, maximumBytes: maximumBytes ?? null }
    });
  }
  const directory = await safePrivateSidecarDirectory(root, path.dirname(target), { create: true });
  const existing = await readPrivateSidecar(root, target, { maximumBytes, optional: true });
  const temporary = path.join(directory, `.pending-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
      | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await safePrivateSidecarDirectory(root, directory);
    await rename(temporary, target);
    await syncDirectory(directory);
    await safePrivateSidecarDirectory(root, directory);
    const published = await readPrivateSidecar(root, target, { maximumBytes });
    if (!published.equals(content)) fail('Private mutable sidecar publication changed bytes.');
    return Object.freeze({ created: existing == null });
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function listPrivateSidecar(root, directory, { optional = false } = {}) {
  try {
    const secured = await safePrivateSidecarDirectory(root, directory);
    return await readdir(secured, { withFileTypes: true });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeImmutablePrivateSidecar(root, target, bytes, { maximumBytes } = {}) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || content.length > maximumBytes) {
    throw new SingularityFlowError('Private sidecar exceeds its installed byte ceiling.', {
      code: 'PRIVATE_RECORD_SIZE_LIMIT',
      details: { actualBytes: content.length, maximumBytes: maximumBytes ?? null }
    });
  }
  const directory = await safePrivateSidecarDirectory(root, path.dirname(target), { create: true });
  const existing = await readPrivateSidecar(root, target, { maximumBytes, optional: true });
  if (existing) {
    if (!existing.equals(content)) {
      throw new SingularityFlowError('Private immutable record conflicts with existing bytes.', {
        code: 'PRIVATE_SIDECAR_RECORD_CONFLICT'
      });
    }
    return Object.freeze({ created: false });
  }

  const temporary = path.join(directory, `.pending-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
      | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await safePrivateSidecarDirectory(root, directory);
    try {
      await link(temporary, target);
      await syncDirectory(directory);
      await safePrivateSidecarDirectory(root, directory);
      const published = await readPrivateSidecar(root, target, { maximumBytes });
      if (!published.equals(content)) fail('Private sidecar publication changed bytes.');
      return Object.freeze({ created: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raced = await readPrivateSidecar(root, target, { maximumBytes });
      if (!raced.equals(content)) {
        throw new SingularityFlowError('Private immutable record conflicts with concurrent bytes.', {
          code: 'PRIVATE_SIDECAR_RECORD_CONFLICT'
        });
      }
      return Object.freeze({ created: false });
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
