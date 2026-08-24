import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { gitDir } from './git.mjs';
import { recordSha256 } from './records.mjs';
import {
  posix, secureRepositoryPath, SingularityFlowError, writeAtomic
} from './util.mjs';

const FORMAT = 'publication-preimage-v1';

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

async function captureFiles(directory, relative = '', files = []) {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new SingularityFlowError(`Publication recovery refuses symbolic links in governed state: ${posix(child)}`);
    }
    if (entry.isDirectory()) await captureFiles(directory, child, files);
    else if (entry.isFile()) {
      const absolute = path.join(directory, child);
      const [contents, info] = await Promise.all([readFile(absolute), lstat(absolute)]);
      files.push({
        path: normalizedChild(child),
        mode: info.mode & 0o777,
        size: contents.length,
        sha256: sha256(contents),
        contents: contents.toString('base64')
      });
    } else {
      throw new SingularityFlowError(`Publication recovery supports only regular files and directories: ${posix(child)}`);
    }
  }
  return files;
}

function identity(snapshot) {
  return {
    format: snapshot.format,
    roots: snapshot.roots.map((root) => ({
      path: root.path,
      type: root.type,
      files: root.files.map(({ path: file, mode, size, sha256: hash }) => ({ path: file, mode, size, sha256: hash }))
    }))
  };
}

/** Capture the exact pre-transaction bytes for one or more governed paths. */
export async function capturePublicationPreimage(root, requestedRoots) {
  const candidates = [...new Set((requestedRoots ?? []).map(normalizedRoot))]
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  // Commit scopes often name a governed directory and individual artifacts beneath it. One parent
  // snapshot already contains those descendants; collapsing them keeps the journal bounded and the
  // restore roots non-overlapping without weakening the commit allowlist.
  const roots = candidates.filter((candidate, index) => !candidates.slice(0, index)
    .some((parent) => candidate.startsWith(`${parent}/`)));
  if (!roots.length) throw new SingularityFlowError('Publication recovery requires at least one governed path.');
  assertNonOverlapping(roots);
  const records = [];
  for (const relative of roots) {
    const secured = await secureRepositoryPath(root, relative, { label: 'Publication recovery root' });
    if (!secured.exists) records.push({ path: relative, type: 'absent', files: [] });
    else if (secured.entry.isFile()) {
      const contents = await readFile(secured.absolute);
      records.push({
        path: relative,
        type: 'file',
        files: [{
          path: path.posix.basename(relative), mode: secured.entry.mode & 0o777,
          size: contents.length, sha256: sha256(contents), contents: contents.toString('base64')
        }]
      });
    } else if (secured.entry.isDirectory()) {
      records.push({ path: relative, type: 'directory', files: await captureFiles(secured.absolute) });
    } else {
      throw new SingularityFlowError(`Publication recovery root must be a regular file or directory: ${relative}`);
    }
  }
  const snapshot = { format: FORMAT, roots: records };
  return Object.freeze({ ...snapshot, sha256: recordSha256(identity(snapshot)) });
}

/** Validate every path and byte before recovery is allowed to touch the worktree. */
export function validatePublicationPreimage(snapshot) {
  if (snapshot?.format !== FORMAT || !Array.isArray(snapshot.roots) || !snapshot.roots.length) {
    throw new SingularityFlowError('Publication recovery preimage is missing or has an unsupported format.');
  }
  const roots = snapshot.roots.map((root) => normalizedRoot(root.path));
  assertNonOverlapping(roots);
  for (const [index, root] of snapshot.roots.entries()) {
    if (root.path !== roots[index] || !['absent', 'file', 'directory'].includes(root.type) || !Array.isArray(root.files)) {
      throw new SingularityFlowError(`Publication recovery preimage root is invalid: ${root.path ?? 'unknown'}`);
    }
    if (root.type === 'absent' && root.files.length) {
      throw new SingularityFlowError(`Absent publication recovery root '${root.path}' cannot contain files.`);
    }
    if (root.type === 'file' && root.files.length !== 1) {
      throw new SingularityFlowError(`File publication recovery root '${root.path}' must contain exactly one file.`);
    }
    const seen = new Set();
    for (const file of root.files) {
      const relative = normalizedChild(file.path);
      if (seen.has(relative)) throw new SingularityFlowError(`Publication recovery preimage repeats '${relative}'.`);
      seen.add(relative);
      if (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777
        || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256 ?? '')) {
        throw new SingularityFlowError(`Publication recovery metadata is invalid for '${relative}'.`);
      }
      const contents = Buffer.from(String(file.contents ?? ''), 'base64');
      if (contents.length !== file.size || contents.toString('base64') !== file.contents || sha256(contents) !== file.sha256) {
        throw new SingularityFlowError(`Publication recovery bytes failed integrity validation for '${relative}'.`);
      }
    }
  }
  const expected = recordSha256(identity(snapshot));
  if (snapshot.sha256 !== expected) throw new SingularityFlowError('Publication recovery preimage manifest failed integrity validation.');
  return snapshot;
}

function fileBytes(file) {
  return Buffer.from(file.contents, 'base64');
}

async function materializeSnapshot(base, snapshot) {
  for (const root of snapshot.roots) {
    if (root.type === 'absent') continue;
    if (root.type === 'file') {
      await writeAtomic(path.join(base, root.path), fileBytes(root.files[0]), { mode: 0o600 });
      continue;
    }
    await mkdir(path.join(base, root.path), { recursive: true, mode: 0o700 });
    for (const file of root.files) {
      await writeAtomic(path.join(base, root.path, file.path), fileBytes(file), { mode: 0o600 });
    }
  }
}

async function preserveInterruptedBytes(root, subject, snapshot) {
  const directory = path.join(
    gitDir(root), 'singularity-flow', 'publication-rescues',
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
  await materializeSnapshot(path.join(directory, 'worktree'), snapshot);
  return directory;
}

async function restoreRoot(root, record) {
  const secured = await secureRepositoryPath(root, record.path, { label: 'Publication recovery target' });
  if (record.type === 'absent') {
    if (secured.exists) await rm(secured.absolute, { recursive: true, force: true });
    return;
  }
  if (secured.exists) await rm(secured.absolute, { recursive: true, force: true });
  if (record.type === 'file') {
    await writeAtomic(secured.absolute, fileBytes(record.files[0]), { mode: record.files[0].mode });
    return;
  }
  await mkdir(secured.absolute, { recursive: true });
  for (const file of record.files) {
    await writeAtomic(path.join(secured.absolute, file.path), fileBytes(file), { mode: file.mode });
  }
}

/**
 * Restore an interrupted transaction to its exact preimage, preserving the interrupted bytes first.
 * Only the roots named by the journal are touched; source edits elsewhere in the repository survive.
 */
export async function restorePublicationPreimage(root, snapshot, { subject, preserveCurrent = false } = {}) {
  validatePublicationPreimage(snapshot);
  const current = await capturePublicationPreimage(root, snapshot.roots.map((entry) => entry.path));
  if (current.sha256 === snapshot.sha256) return { restored: false, rescuePath: null, preimageSha256: snapshot.sha256 };
  const rescuePath = preserveCurrent ? await preserveInterruptedBytes(root, subject, current) : null;
  try {
    for (const record of snapshot.roots) await restoreRoot(root, record);
    const restored = await capturePublicationPreimage(root, snapshot.roots.map((entry) => entry.path));
    if (restored.sha256 !== snapshot.sha256) {
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

export { FORMAT as PUBLICATION_PREIMAGE_FORMAT };
