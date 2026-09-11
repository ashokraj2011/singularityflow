/** Bounded no-follow reads and crash-safe no-clobber writes for release authority files. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

const MAX_PORTABLE_COMPONENT_BYTES = 255;
const MAX_PORTABLE_COMPONENT_UTF16_UNITS = 255;

function assertPortableOutputName(file, label = 'Release output') {
  const name = path.basename(file);
  if (!name || name === '.' || name === '..'
      || Buffer.byteLength(name, 'utf8') > MAX_PORTABLE_COMPONENT_BYTES
      || name.length > MAX_PORTABLE_COMPONENT_UTF16_UNITS) {
    throw new Error(`${label} filename exceeds the portable filesystem boundary.`);
  }
}

export async function readStableReleaseFile(file, {
  label = 'Release file',
  maxBytes = 8 * 1024 * 1024
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`${label} byte boundary must be a positive safe integer.`);
  }
  const requested = path.resolve(file);
  const before = await lstat(requested).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) {
    throw new Error(`${label} must be an ordinary file from 1 to ${maxBytes} bytes: ${requested}.`);
  }
  let handle;
  try { handle = await open(requested, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { throw new Error(`${label} could not be opened without following a link: ${requested}.`); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.size < 1 || opened.size > maxBytes) {
      throw new Error(`${label} changed size before it could be read.`);
    }
    const bytes = await handle.readFile();
    const after = await lstat(requested).catch(() => null);
    if (!after?.isFile() || after.isSymbolicLink() || bytes.length !== opened.size
        || (before.ino && opened.ino && (before.ino !== opened.ino || before.dev !== opened.dev))
        || (after.ino && opened.ino && (after.ino !== opened.ino || after.dev !== opened.dev))) {
      throw new Error(`${label} changed identity while it was read.`);
    }
    return Object.freeze({ path: requested, bytes });
  } finally {
    await handle.close();
  }
}

export async function readStableReleaseJson(file, options = {}) {
  const stable = await readStableReleaseFile(file, options);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(stable.bytes); }
  catch { throw new Error(`${options.label ?? 'Release JSON'} is not valid UTF-8.`); }
  try { return Object.freeze({ ...stable, value: JSON.parse(text) }); }
  catch (error) { throw new Error(`${options.label ?? 'Release JSON'} is invalid JSON: ${error.message}`); }
}

async function syncDirectory(directory) {
  // POSIX needs the directory entry flushed after the hard-link claim. Windows does not expose a
  // portable directory-fsync handle through Node; NTFS link creation itself is the atomic claim.
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Publish complete bytes atomically without ever replacing an existing authority file. */
export async function writeReleaseFileNoClobber(file, bytes, {
  mode = 0o600,
  beforeClaim = null,
  afterClaim = null
} = {}) {
  const requested = path.resolve(file);
  assertPortableOutputName(requested);
  const parent = await realpath(path.dirname(requested));
  const output = path.join(parent, path.basename(requested));
  // Keep the private name independent of the requested filename so a valid 255-byte output name
  // never turns into an overlong temporary component.
  const temporary = path.join(parent, `.sflow-release-output-${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(temporary, 'wx', mode);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeClaim?.();
    // Same-directory hard-link creation is an atomic no-clobber claim on POSIX and NTFS. If the
    // filesystem cannot provide it, fail closed instead of falling back to an overwriting rename.
    await link(temporary, output);
    const [temporaryInfo, outputInfo] = await Promise.all([lstat(temporary), lstat(output)]);
    if (!outputInfo.isFile() || outputInfo.isSymbolicLink()
        || (temporaryInfo.ino && outputInfo.ino
          && (temporaryInfo.ino !== outputInfo.ino || temporaryInfo.dev !== outputInfo.dev))) {
      // Do not unlink an identity that changed in an externally writable parent; it may no longer
      // be our claim. Fail closed and leave reconciliation to the operator.
      throw new Error('Release output atomic claim did not preserve the verified file identity.');
    }
    await syncDirectory(parent);
    await afterClaim?.();
    await rm(temporary, { force: true });
    temporaryExists = false;
    await syncDirectory(parent);
    return output;
  } finally {
    if (temporaryExists) await rm(temporary, { force: true });
  }
}

export async function writeReleaseJsonNoClobber(file, value, options = {}) {
  return writeReleaseFileNoClobber(file, `${JSON.stringify(value, null, 2)}\n`, options);
}
