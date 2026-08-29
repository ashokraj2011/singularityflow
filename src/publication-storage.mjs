import { createHash } from 'node:crypto';
import {
  chmod, link, lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink
} from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir, gitDir } from './git.mjs';
import { SingularityFlowError } from './util.mjs';

const RUNTIME_ROOT = 'singularity-flow';

export function sharedPublicationStorageDirectory(root, directory) {
  return path.join(gitCommonDir(root), RUNTIME_ROOT, directory);
}

function unsafeStorage(label, target, expectation = 'a real directory') {
  return new SingularityFlowError(`${label} storage must be ${expectation}: ${target}`, {
    code: 'PUBLICATION_RECOVERY_STORAGE_UNSAFE'
  });
}

/**
 * Prove that a recovery directory is made only from real directories below its owning Git dir.
 *
 * Checking only the final record with lstat is insufficient: `singularity-flow` itself could be a
 * symlink, making a regular-looking journal outside the repository eligible for migration or
 * deletion. Walk every controlled component and compare its canonical destination with the one
 * implied by the canonical Git directory before any record is read, linked, renamed, or removed.
 */
async function safeStorageDirectory(base, directory, label, { create = false } = {}) {
  const canonicalBase = await realpath(base);
  let current = base;
  let canonicalExpected = canonicalBase;
  for (const segment of [RUNTIME_ROOT, directory]) {
    current = path.join(current, segment);
    canonicalExpected = path.join(canonicalExpected, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeStorage(label, current);
    if (await realpath(current) !== canonicalExpected) throw unsafeStorage(label, current);
  }
  return true;
}

/** Prepare the repository-common recovery directory before a durable writer uses it. */
export async function prepareSharedPublicationStorage(root, directory, label) {
  const common = gitCommonDir(root);
  await safeStorageDirectory(common, directory, label, { create: true });
  return path.join(common, RUNTIME_ROOT, directory);
}

async function worktreePrivateGitDirectories(root) {
  const common = gitCommonDir(root);
  const canonicalCommon = await realpath(common);
  const selected = new Set();
  const current = gitDir(root);
  const canonicalCurrent = await realpath(current);
  if (canonicalCurrent !== canonicalCommon) selected.add(canonicalCurrent);
  const worktrees = path.join(common, 'worktrees');
  let entries = [];
  try { entries = await readdir(worktrees, { withFileTypes: true }); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const candidate = await realpath(path.join(worktrees, entry.name));
      if (candidate !== canonicalCommon) selected.add(candidate);
    }
  }
  return [...selected].sort();
}

async function existingRegularFile(target, label) {
  let info;
  try { info = await lstat(target); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new SingularityFlowError(`${label} storage is not a regular file: ${target}`, {
      code: 'PUBLICATION_RECOVERY_STORAGE_UNSAFE'
    });
  }
  return true;
}

function divergence(label, paths) {
  return new SingularityFlowError(
    `${label} has divergent repository-shared and worktree-private recovery records. `
    + 'No record was selected or removed; inspect the listed paths before retrying.',
    { code: 'PUBLICATION_RECOVERY_STORAGE_DIVERGED', details: { paths } }
  );
}

/**
 * Resolve one durable recovery record across the repository-common store and every legacy linked
 * worktree store. Equivalent legacy copies are harmless and migrate atomically; disagreement is
 * never resolved by recency because each record may identify a different exact transaction.
 */
export async function resolveSharedPublicationFile(root, {
  directory,
  name,
  label,
  read,
  identity,
  migrate = true
}) {
  const target = path.join(sharedPublicationStorageDirectory(root, directory), name);
  const candidates = [];
  const stores = [
    { base: gitCommonDir(root), target },
    ...(await worktreePrivateGitDirectories(root)).map((base) => ({
      base,
      target: path.join(base, RUNTIME_ROOT, directory, name)
    }))
  ];
  for (const store of stores) {
    if (!(await safeStorageDirectory(store.base, directory, label))) continue;
    const candidate = store.target;
    if (!(await existingRegularFile(candidate, label))) continue;
    const value = await read(candidate);
    candidates.push({ path: candidate, value, identity: identity(value) });
  }
  if (!candidates.length) return null;
  if (new Set(candidates.map((candidate) => candidate.identity)).size !== 1) {
    throw divergence(label, candidates.map((candidate) => candidate.path));
  }
  const common = candidates.find((candidate) => candidate.path === target) ?? null;
  if (!migrate) return { ...(common ?? candidates[0]), migrated: false };

  const expected = candidates[0].identity;
  let created = false;
  if (!common) {
    await prepareSharedPublicationStorage(root, directory, label);
    try {
      // Both locations are inside the same Git common directory, so a hard link gives us an atomic
      // create-if-absent without exposing a partially copied JSON document to another process.
      await link(candidates[0].path, target);
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!(await existingRegularFile(target, label))) throw divergence(label, [target, candidates[0].path]);
    const installed = await read(target);
    if (identity(installed) !== expected) {
      if (created) await unlink(target).catch(() => {});
      throw divergence(label, [target, candidates[0].path]);
    }
    await chmod(target, 0o600);
  }

  const migratedFrom = [];
  for (const candidate of candidates.filter((candidate) => candidate.path !== target)) {
    if (!(await existingRegularFile(candidate.path, label))) continue;
    const latest = await read(candidate.path);
    if (identity(latest) !== expected) throw divergence(label, [target, candidate.path]);
    await unlink(candidate.path);
    migratedFrom.push(candidate.path);
  }
  return {
    path: target,
    value: await read(target),
    identity: expected,
    migrated: created || migratedFrom.length > 0,
    migratedFrom
  };
}

async function directoryIdentity(directory, label, relative = '', records = []) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SingularityFlowError(`${label} storage is not a directory: ${directory}`, {
      code: 'PUBLICATION_RECOVERY_STORAGE_UNSAFE'
    });
  }
  records.push({ path: relative || '.', type: 'directory', mode: info.mode & 0o777 });
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(directory, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new SingularityFlowError(`${label} contains a symbolic link: ${child}`, {
        code: 'PUBLICATION_RECOVERY_STORAGE_UNSAFE'
      });
    }
    if (entry.isDirectory()) await directoryIdentity(child, label, childRelative, records);
    else if (entry.isFile()) {
      const childInfo = await lstat(child);
      const bytes = await readFile(child);
      records.push({
        path: childRelative,
        type: 'file',
        mode: childInfo.mode & 0o777,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      });
    } else {
      throw new SingularityFlowError(`${label} contains an unsupported entry: ${child}`, {
        code: 'PUBLICATION_RECOVERY_STORAGE_UNSAFE'
      });
    }
  }
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

/** Move legacy worktree-private rescue bundles into their repository-shared directory. */
export async function migratePublicationRescues(root) {
  const label = 'Publication rescue';
  const targetParent = sharedPublicationStorageDirectory(root, 'publication-rescues');
  const groups = new Map();
  if (await safeStorageDirectory(gitCommonDir(root), 'publication-rescues', label)) {
    for (const entry of await readdir(targetParent, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new SingularityFlowError(`${label} storage contains an unsafe entry: ${entry.name}`, {
          code: 'PUBLICATION_RECOVERY_STORAGE_UNSAFE'
        });
      }
      groups.set(entry.name, [{ path: path.join(targetParent, entry.name), common: true }]);
    }
  }
  for (const gitDirectory of await worktreePrivateGitDirectories(root)) {
    const parent = path.join(gitDirectory, RUNTIME_ROOT, 'publication-rescues');
    if (!(await safeStorageDirectory(gitDirectory, 'publication-rescues', label))) continue;
    let entries = [];
    try { entries = await readdir(parent, { withFileTypes: true }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new SingularityFlowError(`${label} storage contains an unsafe entry: ${path.join(parent, entry.name)}`, {
          code: 'PUBLICATION_RECOVERY_STORAGE_UNSAFE'
        });
      }
      const records = groups.get(entry.name) ?? [];
      records.push({ path: path.join(parent, entry.name), common: false });
      groups.set(entry.name, records);
    }
  }

  // Complete the entire collision audit before moving or deleting anything.
  for (const records of groups.values()) {
    for (const record of records) record.identity = await directoryIdentity(record.path, label);
    if (new Set(records.map((record) => record.identity)).size !== 1) {
      throw divergence(label, records.map((record) => record.path));
    }
  }

  await prepareSharedPublicationStorage(root, 'publication-rescues', label);
  for (const [name, records] of groups) {
    let common = records.find((record) => record.common) ?? null;
    if (!common) {
      const source = records[0];
      const destination = path.join(targetParent, name);
      try { await rename(source.path, destination); }
      catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
        const installed = await directoryIdentity(destination, label);
        if (installed !== source.identity) throw divergence(label, [destination, source.path]);
        await rm(source.path, { recursive: true, force: true });
      }
      common = { path: destination, common: true, identity: source.identity };
    }
    for (const record of records) {
      if (record.path === common.path) continue;
      const current = await directoryIdentity(record.path, label).catch((error) => {
        if (error?.code === 'ENOENT') return common.identity;
        throw error;
      });
      if (current !== common.identity) throw divergence(label, [common.path, record.path]);
      await rm(record.path, { recursive: true, force: true });
    }
  }
  return targetParent;
}
