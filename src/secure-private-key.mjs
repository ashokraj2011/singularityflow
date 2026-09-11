/** Read a release signing key without following links or accepting shared key permissions. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { secureWindowsAuthAcl } from './mcp-auth-profile.mjs';

const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

export async function readSecurePrivateKey(file, {
  repository,
  label = 'Signing key',
  platform = process.platform,
  windowsAcl = secureWindowsAuthAcl
} = {}) {
  if (!file) throw new Error(`${label} path is required.`);
  const requested = path.resolve(file);
  const before = await lstat(requested).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary non-symlink file: ${requested}.`);
  }
  const canonical = await realpath(requested);
  if (repository) {
    const canonicalRepository = await realpath(path.resolve(repository));
    if (inside(canonicalRepository, canonical)) {
      throw new Error(`${label} must remain outside the release repository.`);
    }
  }
  let handle;
  try {
    handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(`${label} could not be opened without following a link: ${canonical}.`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_PRIVATE_KEY_BYTES) {
      throw new Error(`${label} has an unsafe file type or size.`);
    }
    if (opened.nlink && opened.nlink !== 1) {
      throw new Error(`${label} must have exactly one filesystem link.`);
    }
    if (platform === 'win32') {
      try {
        await windowsAcl(canonical, { apply: false });
      } catch (error) {
        throw new Error(`${label} must have a verified, non-inherited, current-user-only Windows ACL.`, {
          cause: error
        });
      }
    } else {
      if ((opened.mode & 0o077) !== 0) {
        throw new Error(`${label} must not be readable or writable by group or other users (use mode 0600).`);
      }
      if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
        throw new Error(`${label} must be owned by the current user.`);
      }
    }
    const bytes = await handle.readFile();
    const after = await lstat(canonical).catch(() => null);
    if (!after?.isFile() || after.isSymbolicLink() || bytes.length !== opened.size
        || (before.ino && opened.ino && (before.ino !== opened.ino || before.dev !== opened.dev))
        || (after.ino && opened.ino && (after.ino !== opened.ino || after.dev !== opened.dev))) {
      throw new Error(`${label} changed identity while it was read.`);
    }
    return Object.freeze({ path: canonical, bytes });
  } finally {
    await handle.close();
  }
}

/** Read an external public trust root as one stable ordinary file. */
export async function readSecurePublicKey(file, {
  repository,
  label = 'Trusted public key'
} = {}) {
  if (!file) throw new Error(`${label} path is required.`);
  const requested = path.resolve(file);
  const before = await lstat(requested).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary non-symlink file: ${requested}.`);
  }
  const canonical = await realpath(requested);
  if (repository) {
    const canonicalRepository = await realpath(path.resolve(repository));
    if (inside(canonicalRepository, canonical)) {
      throw new Error(`${label} must remain outside the release repository.`);
    }
  }
  let handle;
  try {
    handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(`${label} could not be opened without following a link: ${canonical}.`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_PRIVATE_KEY_BYTES
        || (opened.nlink && opened.nlink !== 1)) {
      throw new Error(`${label} has an unsafe file type, size, or link count.`);
    }
    const bytes = await handle.readFile();
    const after = await lstat(canonical).catch(() => null);
    if (!after?.isFile() || after.isSymbolicLink() || bytes.length !== opened.size
        || (before.ino && opened.ino && (before.ino !== opened.ino || before.dev !== opened.dev))
        || (after.ino && opened.ino && (after.ino !== opened.ino || after.dev !== opened.dev))) {
      throw new Error(`${label} changed identity while it was read.`);
    }
    return Object.freeze({ path: canonical, bytes });
  } finally {
    await handle.close();
  }
}
