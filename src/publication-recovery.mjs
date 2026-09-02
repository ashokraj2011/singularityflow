import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { migratePublicationRescues, sharedPublicationStorageDirectory } from './publication-storage.mjs';
import {
  exists, posix, run, secureRepositoryPath, SingularityFlowError, writeAtomic
} from './util.mjs';

const FORMAT = 'publication-preimage-v2';
const LEGACY_FORMAT = 'publication-preimage-v1';
const REWORK_BASELINE_REF_PREFIX = 'refs/singularity-flow/rework-baselines/';
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LIMITS = Object.freeze({
  maximumFiles: 20_000,
  maximumFileBytes: 64 * 1024 * 1024,
  maximumTotalBytes: 256 * 1024 * 1024,
  maximumDepth: 64
});
const RESCUE_LIMITS = Object.freeze({
  maximumPerSubject: 3,
  maximumTotalBytes: 512 * 1024 * 1024,
  maximumAgeMs: 30 * 24 * 60 * 60 * 1000
});

function safeId(value) {
  return encodeURIComponent(String(value ?? 'unknown')).replace(/%/g, '_');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedRoot(candidate) {
  const value = posix(String(candidate ?? '').trim()).replace(/^\.\//, '').replace(/\/$/, '');
  if (!value || value === '.' || value.includes('\\') || path.posix.isAbsolute(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new SingularityFlowError(`Publication recovery root must be one safe repository-relative path: ${candidate}`);
  }
  return value;
}

function normalizedChild(candidate) {
  const value = posix(String(candidate ?? '')).replace(/^\.\//, '');
  if (!value || value.includes('\\') || path.posix.isAbsolute(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new SingularityFlowError(`Publication recovery entry is unsafe: ${candidate}`);
  }
  return value;
}

function assertNonOverlapping(roots) {
  for (const [index, left] of roots.entries()) {
    for (const right of roots.slice(index + 1)) {
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        throw new SingularityFlowError(`Publication recovery roots overlap: ${left}, ${right}`);
      }
    }
  }
}

function blobDirectory(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'publication-preimages', 'sha256');
}

function blobPath(root, digest) {
  return path.join(blobDirectory(root), digest.slice(0, 2), digest.slice(2));
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readStableRegularFile(repositoryRoot, absolute, relative) {
  const canonicalRoot = await realpath(repositoryRoot);
  const canonicalBefore = await realpath(absolute).catch(() => null);
  if (!canonicalBefore || !within(canonicalRoot, canonicalBefore)) {
    throw new SingularityFlowError(`Publication recovery path escaped the repository: ${relative}`);
  }
  let handle;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) throw new SingularityFlowError(`Publication recovery supports only regular files: ${relative}`);
    if (before.size > LIMITS.maximumFileBytes) {
      throw new SingularityFlowError(
        `Publication recovery file '${relative}' exceeds ${LIMITS.maximumFileBytes} bytes.`,
        { code: 'PUBLICATION_PREIMAGE_QUOTA_EXCEEDED' }
      );
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    const canonicalAfter = await realpath(absolute).catch(() => null);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || canonicalAfter !== canonicalBefore) {
      throw new SingularityFlowError(`Publication recovery path changed while being captured: ${relative}`, {
        code: 'PUBLICATION_PREIMAGE_PATH_RACE'
      });
    }
    return { contents, info: after };
  } finally { await handle?.close().catch(() => {}); }
}

async function persistBlob(root, contents) {
  const digest = sha256(contents);
  const target = blobPath(root, digest);
  if (!(await exists(target))) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await writeAtomic(target, contents, { mode: 0o600 }); }
    catch (error) { if (!(await exists(target))) throw error; }
  }
  const stored = await readFile(target);
  if (stored.length !== contents.length || sha256(stored) !== digest) {
    throw new SingularityFlowError(`Publication preimage blob ${digest} failed integrity validation.`, {
      code: 'PUBLICATION_PREIMAGE_CORRUPT'
    });
  }
  return { algorithm: 'sha256', digest };
}

function consumeQuota(quota, relative, size) {
  quota.files += 1;
  quota.bytes += size;
  if (quota.files > LIMITS.maximumFiles || quota.bytes > LIMITS.maximumTotalBytes) {
    throw new SingularityFlowError(
      `Publication recovery preimage exceeds its bounded quota at '${relative}' (${quota.files} files, ${quota.bytes} bytes).`,
      { code: 'PUBLICATION_PREIMAGE_QUOTA_EXCEEDED', details: { ...quota, limits: LIMITS } }
    );
  }
}

async function captureFile(repositoryRoot, absolute, relative, quota) {
  const { contents, info } = await readStableRegularFile(repositoryRoot, absolute, relative);
  consumeQuota(quota, relative, contents.length);
  return {
    path: normalizedChild(relative),
    mode: info.mode & 0o777,
    size: contents.length,
    sha256: sha256(contents),
    blob: await persistBlob(repositoryRoot, contents)
  };
}

async function captureDirectory(repositoryRoot, directory, relative = '', files = [], directories = [], quota = { files: 0, bytes: 0 }, depth = 0, repositoryRelative = null) {
  if (depth > LIMITS.maximumDepth) {
    throw new SingularityFlowError(`Publication recovery directory depth exceeds ${LIMITS.maximumDepth}.`, {
      code: 'PUBLICATION_PREIMAGE_QUOTA_EXCEEDED'
    });
  }
  const secured = await secureRepositoryPath(repositoryRoot, repositoryRelative ?? posix(path.relative(repositoryRoot, directory)), {
    label: 'Publication recovery directory', mustExist: true, type: 'directory'
  });
  const canonicalRoot = await realpath(repositoryRoot);
  const canonicalDirectory = await realpath(secured.absolute);
  if (!within(canonicalRoot, canonicalDirectory)) {
    throw new SingularityFlowError(`Publication recovery directory escaped the repository: ${relative || '.'}`);
  }
  const entries = await readdir(secured.absolute, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    const absolute = path.join(secured.absolute, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new SingularityFlowError(`Publication recovery refuses symbolic links in governed state: ${posix(child)}`, {
        code: 'PUBLICATION_PREIMAGE_SYMBOLIC_LINK',
        details: { path: posix(child), reason: 'symbolic-link' }
      });
    }
    if (info.isDirectory()) {
      directories.push({ path: normalizedChild(child), mode: info.mode & 0o777 });
      const childRepositoryRelative = `${repositoryRelative ?? posix(path.relative(repositoryRoot, directory))}/${entry.name}`;
      await captureDirectory(repositoryRoot, absolute, child, files, directories, quota, depth + 1, childRepositoryRelative);
    } else if (info.isFile()) {
      files.push(await captureFile(repositoryRoot, absolute, child, quota));
    } else {
      throw new SingularityFlowError(`Publication recovery supports only regular files and directories: ${posix(child)}`);
    }
  }
  return { files, directories };
}

function identity(snapshot) {
  return {
    format: snapshot.format,
    // `refs` was not present in historical v1/v2 manifests. Its conditional inclusion keeps
    // those manifests verifiable while binding every newly captured owned ref into the same
    // durable preimage digest as the worktree bytes.
    ...(Object.hasOwn(snapshot, 'refs') ? {
      ...(Object.hasOwn(snapshot, 'refPrefixes') ? { refPrefixes: [...snapshot.refPrefixes] } : {}),
      refs: snapshot.refs.map(({ name, target }) => ({ name, target }))
    } : {}),
    roots: snapshot.roots.map((root) => ({
      path: root.path,
      type: root.type,
      ...(snapshot.format === FORMAT ? {
        mode: root.mode ?? null,
        directories: (root.directories ?? []).map(({ path: directory, mode }) => ({ path: directory, mode }))
      } : {}),
      files: root.files.map(({ path: file, mode, size, sha256: hash, blob }) => ({
        path: file, mode, size, sha256: hash,
        ...(blob ? { blob: { algorithm: blob.algorithm, digest: blob.digest } } : {})
      }))
    }))
  };
}

function normalizedReworkBaselineRef(candidate) {
  const value = String(candidate ?? '');
  const suffix = value.startsWith(REWORK_BASELINE_REF_PREFIX)
    ? value.slice(REWORK_BASELINE_REF_PREFIX.length)
    : '';
  const components = suffix.split('/');
  if (!suffix || value.length > 1024 || value.endsWith('.') || value.includes('..')
    || value.includes('@{') || value.includes('//') || /[\x00-\x20\x7f~^:?*\[\\]/.test(value)
    || components.some((component) => !component || component.startsWith('.') || component.endsWith('.lock'))) {
    throw new SingularityFlowError(`Publication recovery ref is outside the owned rework-baseline namespace: ${value || 'unknown'}`);
  }
  return value;
}

function normalizedReworkBaselinePrefix(candidate) {
  const value = String(candidate ?? '');
  if (value === REWORK_BASELINE_REF_PREFIX) return value;
  if (!value.endsWith('/')) {
    throw new SingularityFlowError(`Publication recovery ref prefix must end in '/': ${value || 'unknown'}`);
  }
  normalizedReworkBaselineRef(`${value}${'0'.repeat(64)}`);
  return value;
}

export function publicationReworkRefNamespace(subject) {
  if (!subject?.kind || !subject?.id) {
    throw new SingularityFlowError('Publication recovery ref namespace requires a complete subject identity.');
  }
  return `${REWORK_BASELINE_REF_PREFIX}${sha256(`${subject.kind}\0${subject.id}`)}/`;
}

function captureReworkBaselineRefs(root, requestedPrefixes = [REWORK_BASELINE_REF_PREFIX]) {
  const prefixes = [...new Set(requestedPrefixes.map(normalizedReworkBaselinePrefix))]
    .sort((left, right) => left.localeCompare(right));
  const result = run('git', [
    'for-each-ref', '--format=%(refname)%00%(objectname)', ...prefixes
  ], { cwd: root });
  const refs = String(result.stdout ?? '').split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('\0');
    if (separator <= 0 || line.indexOf('\0', separator + 1) !== -1) {
      throw new SingularityFlowError('Git returned malformed rework-baseline ref metadata.', {
        code: 'PUBLICATION_PREIMAGE_REF_INVALID'
      });
    }
    const name = normalizedReworkBaselineRef(line.slice(0, separator));
    if (!prefixes.some((prefix) => name.startsWith(prefix))) {
      throw new SingularityFlowError(`Git returned rework-baseline ref '${name}' outside the requested recovery namespace.`, {
        code: 'PUBLICATION_PREIMAGE_REF_INVALID'
      });
    }
    const target = line.slice(separator + 1);
    if (!GIT_OBJECT_ID_PATTERN.test(target)) {
      throw new SingularityFlowError(`Publication recovery ref '${name}' has an invalid object ID.`, {
        code: 'PUBLICATION_PREIMAGE_REF_INVALID'
      });
    }
    return { name, target };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(refs.map(({ name }) => name)).size !== refs.length) {
    throw new SingularityFlowError('Git returned duplicate rework-baseline refs.', {
      code: 'PUBLICATION_PREIMAGE_REF_INVALID'
    });
  }
  return refs;
}

function comparableState(snapshot, target) {
  const modern = target.format === FORMAT;
  return {
    ...(Object.hasOwn(target, 'refs') ? {
      refs: (snapshot.refs ?? []).map(({ name, target: objectId }) => ({ name, target: objectId }))
    } : {}),
    roots: snapshot.roots.map((root) => ({
      path: root.path,
      type: root.type,
      ...(modern ? {
        mode: root.mode ?? null,
        directories: (root.directories ?? []).map(({ path: directory, mode }) => ({ path: directory, mode }))
      } : {}),
      files: root.files.map(({ path: file, mode, size, sha256: hash }) => ({
        path: file, mode, size, sha256: hash
      }))
    }))
  };
}

function publicationStatesEqual(current, target) {
  return recordSha256(comparableState(current, target)) === recordSha256(comparableState(target, target));
}

/** Capture a quota-bounded manifest whose bytes live in the machine-local content-addressed store. */
export async function capturePublicationPreimage(root, requestedRoots, options = {}) {
  // Ref authority is opt-in and scoped: production transactions supply their subject-derived
  // prefix. A plain file-preimage caller therefore cannot accidentally acquire authority over
  // every Story's private rework checkpoints.
  const refPrefixes = options.refPrefixes ?? [];
  const includeOwnedRefs = options.includeOwnedRefs ?? Object.hasOwn(options, 'refPrefixes');
  const candidates = [...new Set((requestedRoots ?? []).map(normalizedRoot))]
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  const roots = candidates.filter((candidate, index) => !candidates.slice(0, index)
    .some((parent) => candidate.startsWith(`${parent}/`)));
  if (!roots.length) throw new SingularityFlowError('Publication recovery requires at least one governed path.');
  assertNonOverlapping(roots);
  const records = [];
  const quota = { files: 0, bytes: 0 };
  for (const relative of roots) {
    // Inspect the final directory entry itself.  A publication is not allowed to begin from a
    // symlink, but recovery needs to distinguish an exact-root symlink created by the interrupted
    // mutation from a symlinked ancestor (which remains an unsafe escape and must fail closed).
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Publication recovery root', allowFinalSymlink: true
    });
    if (!secured.exists) records.push({ path: relative, type: 'absent', mode: null, directories: [], files: [] });
    else if (secured.entry.isSymbolicLink()) {
      throw new SingularityFlowError(`Publication recovery refuses symbolic links in governed state: ${relative}`, {
        code: 'PUBLICATION_PREIMAGE_SYMBOLIC_LINK',
        details: { path: relative, reason: 'symbolic-link' }
      });
    }
    else if (secured.entry.isFile()) {
      records.push({
        path: relative, type: 'file', mode: null, directories: [],
        files: [await captureFile(root, secured.absolute, path.posix.basename(relative), quota)]
      });
    } else if (secured.entry.isDirectory()) {
      const captured = await captureDirectory(root, secured.absolute, '', [], [], quota, 0, relative);
      records.push({
        path: relative, type: 'directory', mode: secured.entry.mode & 0o777,
        directories: captured.directories, files: captured.files
      });
    } else {
      throw new SingularityFlowError(`Publication recovery root must be a regular file or directory: ${relative}`);
    }
  }
  const snapshot = {
    format: FORMAT,
    ...(includeOwnedRefs ? {
      refPrefixes: [...new Set(refPrefixes.map(normalizedReworkBaselinePrefix))]
        .sort((left, right) => left.localeCompare(right)),
      refs: captureReworkBaselineRefs(root, refPrefixes)
    } : {}),
    roots: records
  };
  return Object.freeze({ ...snapshot, sha256: recordSha256(identity(snapshot)) });
}

/** Validate the bounded manifest before recovery is allowed to touch the worktree. */
export function validatePublicationPreimage(snapshot, { subject = null } = {}) {
  if (![FORMAT, LEGACY_FORMAT].includes(snapshot?.format) || !Array.isArray(snapshot.roots) || !snapshot.roots.length) {
    throw new SingularityFlowError('Publication recovery preimage is missing or has an unsupported format.');
  }
  const roots = snapshot.roots.map((root) => normalizedRoot(root.path));
  assertNonOverlapping(roots);
  if (Object.hasOwn(snapshot, 'refPrefixes') && !Object.hasOwn(snapshot, 'refs')) {
    throw new SingularityFlowError('Publication recovery ref prefixes cannot exist without ref metadata.');
  }
  if (Object.hasOwn(snapshot, 'refs')) {
    if (snapshot.format !== FORMAT || !Array.isArray(snapshot.refs)) {
      throw new SingularityFlowError('Publication recovery preimage ref metadata is invalid.');
    }
    const refPrefixes = Object.hasOwn(snapshot, 'refPrefixes')
      ? snapshot.refPrefixes.map(normalizedReworkBaselinePrefix)
      : [REWORK_BASELINE_REF_PREFIX];
    if (!refPrefixes.length || new Set(refPrefixes).size !== refPrefixes.length
      || refPrefixes.some((prefix, index) => index > 0 && refPrefixes[index - 1].localeCompare(prefix) >= 0)
      || refPrefixes.some((prefix, index) => refPrefixes.some((other, otherIndex) =>
        index !== otherIndex && prefix.startsWith(other)))) {
      throw new SingularityFlowError('Publication recovery ref prefixes must be non-overlapping and canonically ordered.');
    }
    const refs = snapshot.refs.map((entry) => {
      if (!entry || Object.keys(entry).sort().join(',') !== 'name,target') {
        throw new SingularityFlowError('Publication recovery preimage ref metadata is invalid.');
      }
      const name = normalizedReworkBaselineRef(entry.name);
      if (!refPrefixes.some((prefix) => name.startsWith(prefix))) {
        throw new SingularityFlowError(`Publication recovery ref '${name}' is outside its captured namespace.`);
      }
      if (!GIT_OBJECT_ID_PATTERN.test(entry.target ?? '')) {
        throw new SingularityFlowError(`Publication recovery ref '${name}' has an invalid object ID.`);
      }
      return name;
    });
    if (new Set(refs).size !== refs.length || refs.some((name, index) => index > 0 && refs[index - 1].localeCompare(name) >= 0)) {
      throw new SingularityFlowError('Publication recovery preimage refs must be unique and canonically ordered.');
    }
  }
  let files = 0; let bytes = 0;
  for (const [index, root] of snapshot.roots.entries()) {
    if (root.path !== roots[index] || !['absent', 'file', 'directory'].includes(root.type) || !Array.isArray(root.files)) {
      throw new SingularityFlowError(`Publication recovery preimage root is invalid: ${root.path ?? 'unknown'}`);
    }
    if (root.type === 'absent' && root.files.length) throw new SingularityFlowError(`Absent publication recovery root '${root.path}' cannot contain files.`);
    if (root.type === 'file' && root.files.length !== 1) throw new SingularityFlowError(`File publication recovery root '${root.path}' must contain exactly one file.`);
    if (snapshot.format === FORMAT) {
      if (root.type === 'directory' && (!Number.isSafeInteger(root.mode) || root.mode < 0 || root.mode > 0o777)) {
        throw new SingularityFlowError(`Publication recovery directory mode is invalid for '${root.path}'.`);
      }
      for (const directory of root.directories ?? []) {
        normalizedChild(directory.path);
        if (!Number.isSafeInteger(directory.mode) || directory.mode < 0 || directory.mode > 0o777) {
          throw new SingularityFlowError(`Publication recovery directory metadata is invalid for '${directory.path}'.`);
        }
      }
    }
    const seen = new Set();
    for (const file of root.files) {
      const relative = normalizedChild(file.path);
      if (seen.has(relative)) throw new SingularityFlowError(`Publication recovery preimage repeats '${relative}'.`);
      seen.add(relative); files += 1; bytes += Number(file.size ?? 0);
      if (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.maximumFileBytes
        || !/^[0-9a-f]{64}$/.test(file.sha256 ?? '')) {
        throw new SingularityFlowError(`Publication recovery metadata is invalid for '${relative}'.`);
      }
      if (snapshot.format === FORMAT) {
        if (file.contents != null || file.blob?.algorithm !== 'sha256' || file.blob?.digest !== file.sha256) {
          throw new SingularityFlowError(`Publication recovery blob reference is invalid for '${relative}'.`);
        }
      } else {
        const contents = Buffer.from(String(file.contents ?? ''), 'base64');
        if (contents.length !== file.size || contents.toString('base64') !== file.contents || sha256(contents) !== file.sha256) {
          throw new SingularityFlowError(`Publication recovery bytes failed integrity validation for '${relative}'.`);
        }
      }
    }
  }
  if (files > LIMITS.maximumFiles || bytes > LIMITS.maximumTotalBytes) {
    throw new SingularityFlowError('Publication recovery manifest exceeds its bounded quota.', { code: 'PUBLICATION_PREIMAGE_QUOTA_EXCEEDED' });
  }
  const expected = recordSha256(identity(snapshot));
  if (snapshot.sha256 !== expected) throw new SingularityFlowError('Publication recovery preimage manifest failed integrity validation.');
  if (Object.hasOwn(snapshot, 'refs')) {
    if (!subject?.kind || !subject?.id) {
      throw new SingularityFlowError(
        'Publication recovery requires the transaction subject before admitting ref-bearing preimage authority.',
        { code: 'PUBLICATION_PREIMAGE_SUBJECT_MISMATCH' }
      );
    }
    const expectedRefPrefix = publicationReworkRefNamespace(subject);
    if (!Object.hasOwn(snapshot, 'refPrefixes') || snapshot.refPrefixes.length !== 1
      || snapshot.refPrefixes[0] !== expectedRefPrefix) {
      throw new SingularityFlowError(
        `Publication recovery preimage does not belong to ${subject.kind} '${subject.id}'.`,
        {
          code: 'PUBLICATION_PREIMAGE_SUBJECT_MISMATCH',
          details: {
            subject: { kind: subject.kind, id: subject.id },
            expectedRefPrefix,
            capturedRefPrefixes: snapshot.refPrefixes ?? []
          }
        }
      );
    }
  }
  return snapshot;
}

async function fileBytes(root, snapshot, file) {
  if (snapshot.format === LEGACY_FORMAT) return Buffer.from(file.contents, 'base64');
  const target = blobPath(root, file.blob.digest);
  const securedStore = await realpath(blobDirectory(root)).catch(() => null);
  const securedBlob = await realpath(target).catch(() => null);
  if (!securedStore || !securedBlob || !within(securedStore, securedBlob)) {
    throw new SingularityFlowError(`Publication recovery blob ${file.blob.digest} is missing or unsafe.`, { code: 'PUBLICATION_PREIMAGE_CORRUPT' });
  }
  const contents = await readFile(securedBlob);
  if (contents.length !== file.size || sha256(contents) !== file.sha256) {
    throw new SingularityFlowError(`Publication recovery blob ${file.blob.digest} failed integrity validation.`, { code: 'PUBLICATION_PREIMAGE_CORRUPT' });
  }
  return contents;
}

async function materializeSnapshot(repositoryRoot, base, snapshot) {
  for (const root of snapshot.roots) {
    if (root.type === 'absent') continue;
    if (root.type === 'file') {
      await writeAtomic(path.join(base, root.path), await fileBytes(repositoryRoot, snapshot, root.files[0]), { mode: root.files[0].mode });
      continue;
    }
    await mkdir(path.join(base, root.path), { recursive: true, mode: root.mode ?? 0o700 });
    for (const directory of root.directories ?? []) {
      await mkdir(path.join(base, root.path, directory.path), { recursive: true, mode: directory.mode });
    }
    for (const file of root.files) {
      await writeAtomic(path.join(base, root.path, file.path), await fileBytes(repositoryRoot, snapshot, file), { mode: file.mode });
    }
  }
}

function snapshotBytes(snapshot) {
  return snapshot.roots.reduce((total, root) => total
    + root.files.reduce((sum, file) => sum + Number(file.size ?? 0), 0), 0);
}

async function rescueBytes(directory, depth = 0) {
  if (depth > LIMITS.maximumDepth) return RESCUE_LIMITS.maximumTotalBytes;
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await rescueBytes(target, depth + 1);
    else if (entry.isFile()) total += (await lstat(target)).size;
    if (total > RESCUE_LIMITS.maximumTotalBytes) return total;
  }
  return total;
}

async function pruneRescues(root, subject, incomingBytes) {
  const parent = await migratePublicationRescues(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const prefix = `${safeId(subject.kind)}--${safeId(subject.id)}--`;
  const entries = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const target = path.join(parent, entry.name);
    const info = await lstat(target);
    entries.push({
      target,
      name: entry.name,
      subject: entry.name.startsWith(prefix),
      modifiedAt: info.mtimeMs,
      bytes: await rescueBytes(target)
    });
  }
  const remove = async (entry) => {
    await rm(entry.target, { recursive: true, force: true });
    entry.removed = true;
  };
  const now = Date.now();
  for (const entry of entries) {
    if (now - entry.modifiedAt > RESCUE_LIMITS.maximumAgeMs) await remove(entry);
  }
  const forSubject = entries.filter((entry) => entry.subject && !entry.removed)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const entry of forSubject.slice(Math.max(0, RESCUE_LIMITS.maximumPerSubject - 1))) await remove(entry);
  const retained = entries.filter((entry) => !entry.removed)
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
  let total = retained.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of retained) {
    if (total + incomingBytes <= RESCUE_LIMITS.maximumTotalBytes) break;
    await remove(entry);
    total -= entry.bytes;
  }
  if (total + incomingBytes > RESCUE_LIMITS.maximumTotalBytes) {
    throw new SingularityFlowError('Interrupted-byte rescue exceeds the bounded machine-local retention quota.', {
      code: 'PUBLICATION_RESCUE_QUOTA_EXCEEDED',
      details: { incomingBytes, retainedBytes: total, limits: RESCUE_LIMITS }
    });
  }
}

async function preserveInterruptedBytes(root, subject, snapshot) {
  const bytes = snapshotBytes(snapshot);
  await pruneRescues(root, subject, bytes);
  const directory = path.join(
    sharedPublicationStorageDirectory(root, 'publication-rescues'),
    `${safeId(subject.kind)}--${safeId(subject.id)}--${Date.now()}--${randomUUID()}`
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(directory, 'RECOVERY.txt'), [
    'Singularity Flow interrupted publication rescue',
    `Subject: ${subject.kind} ${subject.id}`,
    `Captured: ${new Date().toISOString()}`,
    `Snapshot: ${snapshot.sha256}`,
    '',
    'The worktree/ directory contains the bytes found after the interrupted process exited.',
    'They were preserved before Singularity Flow restored the pre-transaction state.',
    ''
  ].join('\n'), { mode: 0o600 });
  await writeAtomic(path.join(directory, 'rescue.json'), `${JSON.stringify({
    schemaVersion: 1, // schema-transient: diagnostic metadata inside a bounded disposable rescue.
    subject,
    capturedAt: new Date().toISOString(),
    snapshotSha256: snapshot.sha256,
    bytes,
    retention: RESCUE_LIMITS
  }, null, 2)}\n`, { mode: 0o600 });
  await materializeSnapshot(root, path.join(directory, 'worktree'), snapshot);
  return directory;
}

async function restoreRoot(repositoryRoot, record, snapshot) {
  // allowFinalSymlink validates the real parent while deliberately not resolving the final link.
  // Removing that exact directory entry is safe; a symlinked ancestor is still rejected.
  const secured = await secureRepositoryPath(repositoryRoot, record.path, {
    label: 'Publication recovery target', allowFinalSymlink: true
  });
  if (record.type === 'absent') {
    if (secured.exists) await rm(secured.absolute, {
      recursive: !secured.entry.isSymbolicLink(), force: true
    });
    return;
  }
  if (secured.exists) await rm(secured.absolute, {
    recursive: !secured.entry.isSymbolicLink(), force: true
  });
  if (record.type === 'file') {
    await writeAtomic(secured.absolute, await fileBytes(repositoryRoot, snapshot, record.files[0]), { mode: record.files[0].mode });
    return;
  }
  await mkdir(secured.absolute, { recursive: true, mode: record.mode ?? 0o700 });
  for (const directory of record.directories ?? []) {
    await mkdir(path.join(secured.absolute, directory.path), { recursive: true, mode: directory.mode });
  }
  for (const file of record.files) {
    await writeAtomic(path.join(secured.absolute, file.path), await fileBytes(repositoryRoot, snapshot, file), { mode: file.mode });
  }
  for (const directory of [...(record.directories ?? [])].sort((a, b) => b.path.length - a.path.length)) {
    await chmod(path.join(secured.absolute, directory.path), directory.mode);
  }
  if (record.mode != null) await chmod(secured.absolute, record.mode);
}

function restoreReworkBaselineRefs(root, desiredRefs, refPrefixes = [REWORK_BASELINE_REF_PREFIX]) {
  const currentRefs = captureReworkBaselineRefs(root, refPrefixes);
  const desired = new Map(desiredRefs.map(({ name, target }) => [name, target]));
  const current = new Map(currentRefs.map(({ name, target }) => [name, target]));
  const changes = [];
  for (const [name, target] of current) {
    if (!desired.has(name)) changes.push(`delete ${name} ${target}`);
  }
  for (const [name, target] of desired) {
    const existing = current.get(name);
    if (existing === target) continue;
    changes.push(`update ${name} ${target} ${existing ?? '0'.repeat(target.length)}`);
  }
  if (!changes.length) return false;
  // One ref transaction gives every update/delete an old-object lease and commits the complete
  // namespace restoration atomically. A concurrent writer therefore causes a safe refusal instead
  // of losing its ref or leaving a partially restored set.
  run('git', ['update-ref', '--stdin'], {
    cwd: root,
    input: ['start', ...changes, 'prepare', 'commit', ''].join('\n')
  });
  return true;
}

/** Restore exact bytes and directory/file modes, preserving interrupted bytes before replacement. */
export async function restorePublicationPreimage(root, snapshot, { subject, preserveCurrent = false } = {}) {
  validatePublicationPreimage(snapshot, { subject });
  for (const record of snapshot.roots) for (const file of record.files) await fileBytes(root, snapshot, file);
  let current = null;
  try {
    current = await capturePublicationPreimage(root, snapshot.roots.map((entry) => entry.path), {
      includeOwnedRefs: Object.hasOwn(snapshot, 'refs'),
      refPrefixes: snapshot.refPrefixes ?? [REWORK_BASELINE_REF_PREFIX]
    });
  } catch (error) {
    // A mutation may replace a governed file, or place an entry beneath a governed directory,
    // with a symlink.  Never follow or retain its target (which may itself contain the rejected
    // secret); restore the durable preimage by unlinking the exact entry.  All other path failures,
    // especially a symlinked ancestor or repository escape, remain fatal.
    if (error?.code !== 'PUBLICATION_PREIMAGE_SYMBOLIC_LINK') throw error;
  }
  if (current && publicationStatesEqual(current, snapshot)) {
    return { restored: false, rescuePath: null, preimageSha256: snapshot.sha256 };
  }
  const rescuePath = preserveCurrent && current
    ? await preserveInterruptedBytes(root, subject, current)
    : null;
  try {
    for (const record of snapshot.roots) await restoreRoot(root, record, snapshot);
    if (Object.hasOwn(snapshot, 'refs')) {
      restoreReworkBaselineRefs(
        root, snapshot.refs, snapshot.refPrefixes ?? [REWORK_BASELINE_REF_PREFIX]
      );
    }
    const restored = await capturePublicationPreimage(root, snapshot.roots.map((entry) => entry.path), {
      includeOwnedRefs: Object.hasOwn(snapshot, 'refs'),
      refPrefixes: snapshot.refPrefixes ?? [REWORK_BASELINE_REF_PREFIX]
    });
    if (!publicationStatesEqual(restored, snapshot)) {
      throw new SingularityFlowError('Publication recovery did not reproduce the durable pre-transaction state.');
    }
    return { restored: true, rescuePath, preimageSha256: snapshot.sha256 };
  } catch (error) {
    throw new SingularityFlowError(
      `Publication recovery could not restore its durable preimage: ${error.message}`
      + `${rescuePath ? ` Interrupted bytes remain preserved at ${rescuePath}.` : ''}`
    );
  }
}

export {
  FORMAT as PUBLICATION_PREIMAGE_FORMAT,
  LIMITS as PUBLICATION_PREIMAGE_LIMITS,
  RESCUE_LIMITS as PUBLICATION_RESCUE_LIMITS
};
