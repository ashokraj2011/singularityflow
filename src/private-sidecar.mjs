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
let defaultWindowsAclPromise = null;

function fail(message, details = null) {
  throw new SingularityFlowError(message, { code: 'PRIVATE_SIDECAR_PATH_UNSAFE', details });
}

function contained(commonDirectory, target) {
  const relative = path.relative(commonDirectory, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function privateAcl(target, {
  directory, apply, platform = process.platform, windowsAcl = null,
  enforceWindowsAcl = false
} = {}) {
  if (platform === 'win32') {
    // Older SFlow releases created generic private-sidecar roots without a protected DACL.
    // Keep that compatibility boundary explicit: only newly security-qualified stores opt in.
    // Normal reads must never mutate an inherited ACL as an implicit upgrade.
    if (!enforceWindowsAcl) return;
    if (typeof windowsAcl !== 'function') {
      defaultWindowsAclPromise ??= import('./mcp-auth-profile.mjs')
        .then((module) => module.secureWindowsAuthAcl);
      windowsAcl = await defaultWindowsAclPromise;
    }
    await windowsAcl(target, { directory, apply });
    return;
  }
  const info = await lstat(target);
  if ((info.mode & 0o077) !== 0) {
    fail(`Private sidecar '${target}' grants group or other access.`);
  }
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

async function validateSidecarTreeDirectory(root, directory, {
  create = false, validateDirectory = null
} = {}) {
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
  for (const [index, segment] of relative.split(path.sep).filter(Boolean).entries()) {
    const parent = cursor;
    cursor = path.join(cursor, segment);
    let info;
    let created = false;
    try { info = await lstat(cursor); } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(cursor, { mode: 0o700 }); created = true; } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      await syncDirectory(parent);
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`Private sidecar ancestor '${cursor}' is not a real directory.`);
    }
    await validateDirectory?.(cursor, { created, index });
  }
  const canonicalCommon = await realpath(commonDirectory);
  const rebound = await realpath(targetDirectory);
  const expectedRebound = path.resolve(canonicalCommon, relative);
  if (rebound !== expectedRebound) {
    fail('Private sidecar directory changed identity during validation.');
  }
  return targetDirectory;
}

/** Validate only containment and real-directory topology for a tree secured as one unit. */
export async function safeSidecarTreeDirectory(root, directory, { create = false } = {}) {
  return validateSidecarTreeDirectory(root, directory, { create });
}

export async function safePrivateSidecarDirectory(root, directory, {
  create = false, platform = process.platform, windowsAcl = null,
  enforceWindowsAcl = false
} = {}) {
  return validateSidecarTreeDirectory(root, directory, {
    create,
    validateDirectory: async (target, { created, index }) => {
      // `.git/singularity-flow` is a compatibility container shared with non-secret local state.
      // Privacy starts at the product-specific child (for example `revisions` or `auto`).
      if (index > 0) {
        await privateAcl(target, {
          directory: true, apply: created, platform, windowsAcl, enforceWindowsAcl
        });
      }
    }
  });
}

export async function readPrivateSidecar(root, target, {
  maximumBytes, optional = false, identityRetries = 3,
  platform = process.platform, windowsAcl = null, enforceWindowsAcl = false
} = {}) {
  try {
    await safePrivateSidecarDirectory(root, path.dirname(target), {
      platform, windowsAcl, enforceWindowsAcl
    });
  }
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
    await privateAcl(target, {
      directory: false, apply: false, platform, windowsAcl, enforceWindowsAcl
    });
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
          maximumBytes, optional, identityRetries: identityRetries - 1,
          platform, windowsAcl, enforceWindowsAcl
        });
      }
      fail(`Private sidecar '${target}' changed identity while it was opened.`);
    }
    if (Number.isSafeInteger(maximumBytes) && info.size > maximumBytes) {
      throw new SingularityFlowError('Private sidecar exceeds its installed byte ceiling.', {
        code: 'PRIVATE_RECORD_SIZE_LIMIT', details: { actualBytes: info.size, maximumBytes }
      });
    }
    await safePrivateSidecarDirectory(root, path.dirname(target), {
      platform, windowsAcl, enforceWindowsAcl
    });
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
export async function writeMutablePrivateSidecar(root, target, bytes, {
  maximumBytes, platform = process.platform, windowsAcl = null, enforceWindowsAcl = false
} = {}) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || content.length > maximumBytes) {
    throw new SingularityFlowError('Private sidecar exceeds its installed byte ceiling.', {
      code: 'PRIVATE_RECORD_SIZE_LIMIT',
      details: { actualBytes: content.length, maximumBytes: maximumBytes ?? null }
    });
  }
  const directory = await safePrivateSidecarDirectory(root, path.dirname(target), {
    create: true, platform, windowsAcl, enforceWindowsAcl
  });
  const existing = await readPrivateSidecar(root, target, {
    maximumBytes, optional: true, platform, windowsAcl, enforceWindowsAcl
  });
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
    await safePrivateSidecarDirectory(root, directory, {
      platform, windowsAcl, enforceWindowsAcl
    });
    await rename(temporary, target);
    await privateAcl(target, {
      directory: false, apply: true, platform, windowsAcl, enforceWindowsAcl
    });
    await syncDirectory(directory);
    await safePrivateSidecarDirectory(root, directory, {
      platform, windowsAcl, enforceWindowsAcl
    });
    const published = await readPrivateSidecar(root, target, {
      maximumBytes, platform, windowsAcl, enforceWindowsAcl
    });
    if (!published.equals(content)) fail('Private mutable sidecar publication changed bytes.');
    return Object.freeze({ created: existing == null });
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function listPrivateSidecar(root, directory, {
  optional = false, platform = process.platform, windowsAcl = null, enforceWindowsAcl = false
} = {}) {
  try {
    const secured = await safePrivateSidecarDirectory(root, directory, {
      platform, windowsAcl, enforceWindowsAcl
    });
    return await readdir(secured, { withFileTypes: true });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeImmutablePrivateSidecar(root, target, bytes, {
  maximumBytes, platform = process.platform, windowsAcl = null, enforceWindowsAcl = false
} = {}) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || content.length > maximumBytes) {
    throw new SingularityFlowError('Private sidecar exceeds its installed byte ceiling.', {
      code: 'PRIVATE_RECORD_SIZE_LIMIT',
      details: { actualBytes: content.length, maximumBytes: maximumBytes ?? null }
    });
  }
  const directory = await safePrivateSidecarDirectory(root, path.dirname(target), {
    create: true, platform, windowsAcl, enforceWindowsAcl
  });
  const existing = await readPrivateSidecar(root, target, {
    maximumBytes, optional: true, platform, windowsAcl, enforceWindowsAcl
  });
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
    await safePrivateSidecarDirectory(root, directory, {
      platform, windowsAcl, enforceWindowsAcl
    });
    try {
      await link(temporary, target);
      await privateAcl(target, {
        directory: false, apply: true, platform, windowsAcl, enforceWindowsAcl
      });
      await syncDirectory(directory);
      await safePrivateSidecarDirectory(root, directory, {
        platform, windowsAcl, enforceWindowsAcl
      });
      const published = await readPrivateSidecar(root, target, {
        maximumBytes, platform, windowsAcl, enforceWindowsAcl
      });
      if (!published.equals(content)) fail('Private sidecar publication changed bytes.');
      return Object.freeze({ created: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raced = await readPrivateSidecar(root, target, {
        maximumBytes, platform, windowsAcl, enforceWindowsAcl
      });
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
