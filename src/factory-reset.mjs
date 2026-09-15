import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm,
  rmdir, symlink, writeFile
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gitCommonDir, gitDir } from './git.mjs';
import { initializeDefinition, loadDefinition } from './config.mjs';
import { assertNoActiveSubjectLocks, withRepositoryResetBarrier } from './subject-lock.mjs';
import { withMachineStateResetBarrier } from './machine-state-reset.mjs';
import { SingularityFlowError, run } from './util.mjs';

const CONTROL_ROOTS = ['singularity', '.singularity', '.sdlc'];
const LOCAL_RUNTIME_ROOT = 'singularity-flow';
const RECOVERED_AGENTS_ROOT = '.github/singularity-flow-recovered-agents';
const RESET_ALL_CONFIRMATION = 'RESET ALL';
const PACKAGED_AGENTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'agents'
);

export function machineStateRoot(home = os.homedir()) {
  return path.join(home, '.singularity-flow');
}

function repositoryIdentity(root) {
  const branchResult = run('git', ['branch', '--show-current'], {
    cwd: root,
    allowFailure: true
  });
  if (branchResult.status !== 0) {
    throw new SingularityFlowError(
      `Cannot determine the current Git branch for ${root}: `
      + `${(branchResult.stderr || branchResult.stdout).trim().split('\n')[0] || 'git branch failed'}.`
    );
  }
  const headResult = run('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root,
    allowFailure: true
  });
  // An empty repository has no HEAD commit yet. That is still a valid Git repository and the reset
  // only replaces SFlow-owned files, so bind its confirmation token to the explicit "unborn"
  // state. Any other rev-parse failure is unexpected and must fail closed.
  const symbolicHead = headResult.status === 0 ? null : run('git', [
    'symbolic-ref', '--quiet', 'HEAD'
  ], {
    cwd: root,
    allowFailure: true
  });
  const symbolicRef = symbolicHead?.status === 0 ? symbolicHead.stdout.trim() : '';
  const refStatus = symbolicRef ? run('git', [
    'show-ref', '--verify', '--quiet', symbolicRef
  ], {
    cwd: root,
    allowFailure: true
  }) : null;
  // Do not classify by Git's localized diagnostic text. A valid symbolic HEAD with no resolvable
  // ref is the structural definition of an unborn branch. An existing but unreadable ref is
  // corruption, not an unborn repository, and remains a fail-closed error.
  const unborn = headResult.status !== 0
    && Boolean(symbolicRef)
    && refStatus?.status === 1;
  if (headResult.status !== 0 && !unborn) {
    throw new SingularityFlowError(
      `Cannot determine the current Git revision for ${root}: `
      + `${(headResult.stderr || headResult.stdout).trim().split('\n')[0] || 'git rev-parse failed'}.`
    );
  }
  return {
    branch: branchResult.stdout.trim() || null,
    head: headResult.status === 0 ? headResult.stdout.trim() : null
  };
}

async function directoryState(target, label) {
  const info = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { exists: false, target };
  if (info.isSymbolicLink()) throw new SingularityFlowError(`${label} must not be a symbolic link: ${target}`);
  if (!info.isDirectory()) throw new SingularityFlowError(`${label} must be a directory: ${target}`);
  return { exists: true, target };
}

async function regularFiles(root, relative = '', output = []) {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) await regularFiles(root, child, output);
    else if (entry.isFile()) output.push(child);
  }
  return output.sort();
}

function resetPathspecs(caseInsensitive) {
  return [...CONTROL_ROOTS, '.github/agents'].map((relative) =>
    `${caseInsensitive ? ':(icase,literal)' : ':(literal)'}${relative}`);
}

function visibleGitPath(value) {
  // Porcelain -z correctly preserves unusual filenames, which also means Git no longer quotes
  // terminal controls for us. JSON escaping every path keeps ESC, tabs, bidi/format controls and
  // other non-printing bytes from rewriting the destructive preview.
  return JSON.stringify(String(value)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    const point = character.codePointAt(0);
    return point <= 0xffff
      ? `\\u${point.toString(16).padStart(4, '0')}`
      : `\\u{${point.toString(16)}}`;
  });
}

function repositoryCaseInsensitive(root) {
  const result = run('git', ['config', '--bool', 'core.ignorecase'], {
    cwd: root,
    allowFailure: true
  });
  if (result.status === 0) return result.stdout.trim() === 'true';
  // Git exits 1 when the key is unset. Fall back conservatively for repositories created by tools
  // that omitted the normal probe; any other failure means we cannot prove the deletion boundary.
  if (result.status === 1 && !(result.stderr || result.stdout).trim()) {
    return process.platform === 'win32' || process.platform === 'darwin';
  }
  throw new SingularityFlowError(
    `Cannot determine repository path-case behavior: `
    + `${(result.stderr || result.stdout).trim().split('\n')[0] || 'git config failed'}. `
    + 'Refusing to reset without that answer.'
  );
}

function changedResetEntries(root, { caseInsensitive }) {
  const pathspecs = resetPathspecs(caseInsensitive);
  const result = run('git', [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--',
    ...pathspecs
  ], {
    cwd: root,
    allowFailure: true
  });
  // Fail closed. This list is the only thing standing between an operator's uncommitted work and an
  // `rm -rf` of the control root, and the guard's premise is that Git history is the recovery path —
  // which is exactly the claim that does not hold for uncommitted files. Returning an empty list on
  // a failed `git status` (a concurrent operation holding index.lock is enough) reported "nothing
  // uncommitted" and deleted the work anyway.
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `Cannot determine whether ${root} has uncommitted governed changes: `
      + `${(result.stderr || result.stdout).trim().split('\n')[0] || 'git status failed'}. `
      + 'Refusing to reset without that answer.'
    );
  }
  const fields = result.stdout.split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    const currentPath = field.slice(3);
    // In porcelain -z output a rename/copy has a second NUL-delimited path. Keep both so moving a
    // file into or out of a reset root cannot evade the discard classification.
    const originalPath = /[RC]/.test(status) ? fields[++index] || null : null;
    entries.push({
      status,
      currentPath,
      originalPath,
      display: `${status} ${visibleGitPath(currentPath)}`
        + `${originalPath ? ` <- ${visibleGitPath(originalPath)}` : ''}`
    });
  }
  // `git status` deliberately honours assume-unchanged and skip-worktree, so it can report a clean
  // tree while locally changed control bytes are about to be deleted. Enumerate those index flags
  // independently and conservatively require explicit data-loss consent for every matching path.
  const index = run('git', ['ls-files', '-v', '-z', '--', ...pathspecs], {
    cwd: root,
    allowFailure: true
  });
  if (index.status !== 0) {
    throw new SingularityFlowError(
      `Cannot inspect hidden Git index flags under the reset boundary: `
      + `${(index.stderr || index.stdout).trim().split('\n')[0] || 'git ls-files failed'}. `
      + 'Refusing to reset without that answer.'
    );
  }
  const recordedPaths = new Set(entries.map((entry) => comparableRepositoryPath(
    entry.currentPath, caseInsensitive
  )));
  for (const field of index.stdout.split('\0')) {
    if (!field) continue;
    const tag = field[0];
    const currentPath = field.slice(2);
    const hidden = tag === 'S' || tag === 's' || tag !== tag.toUpperCase();
    if (!hidden || recordedPaths.has(comparableRepositoryPath(currentPath, caseInsensitive))) continue;
    const reason = tag.toUpperCase() === 'S' ? 'skip-worktree' : 'assume-unchanged';
    entries.push({
      status: tag.toUpperCase() === 'S' ? 'SW' : 'AU',
      currentPath,
      originalPath: null,
      display: `${tag.toUpperCase() === 'S' ? 'SW' : 'AU'} ${visibleGitPath(currentPath)} `
        + `(Git ${reason}; conservatively treated as uncommitted)`
    });
    recordedPaths.add(comparableRepositoryPath(currentPath, caseInsensitive));
  }
  return entries;
}

function caseInsensitiveArgument(value) {
  return typeof value === 'boolean'
    ? value
    : value === 'win32' || value === 'darwin';
}

function comparableRepositoryPath(relative, caseBehavior = process.platform) {
  const normalized = relative.split(path.sep).join('/').replace(/\/$/, '');
  return caseInsensitiveArgument(caseBehavior) ? normalized.toLowerCase() : normalized;
}

export function controlRootPath(relative, caseBehavior = process.platform) {
  const normalized = comparableRepositoryPath(relative, caseBehavior);
  return CONTROL_ROOTS.some((control) => normalized === control || normalized.startsWith(`${control}/`));
}

export function repositoryPathCovers(parent, candidate, caseBehavior = process.platform) {
  const normalizedParent = comparableRepositoryPath(parent, caseBehavior);
  const normalizedCandidate = comparableRepositoryPath(candidate, caseBehavior);
  return normalizedCandidate === normalizedParent
    || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

async function assertSafeDirectoryChain(root, relativeDirectory, label) {
  let cursor = root;
  for (const segment of relativeDirectory.split('/').filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor).catch((error) => error?.code === 'ENOENT'
      ? null : Promise.reject(error));
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new SingularityFlowError(`${label} must not contain a symbolic-link directory: ${cursor}`);
    }
    if (!info.isDirectory()) {
      throw new SingularityFlowError(`${label} must contain only directories: ${cursor}`);
    }
  }
}

async function ensureSafeDirectoryChain(root, relativeDirectory, label) {
  let cursor = root;
  for (const segment of relativeDirectory.split('/').filter(Boolean)) {
    const parent = cursor;
    const parentInfo = await stableLstat(parent);
    if (!parentInfo || parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new SingularityFlowError(`${label} has an unsafe parent directory: ${parent}`);
    }
    cursor = path.join(cursor, segment);
    let info = await stableLstat(cursor);
    if (!info) {
      try { await mkdir(cursor, { recursive: false }); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      info = await stableLstat(cursor);
    }
    if (info?.isSymbolicLink()) {
      throw new SingularityFlowError(`${label} must not contain a symbolic-link directory: ${cursor}`);
    }
    if (!info?.isDirectory()) {
      throw new SingularityFlowError(`${label} must contain only directories: ${cursor}`);
    }
  }
}

function statToken(info) {
  if (!info) return null;
  return [
    info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs
  ].map(String).join(':');
}

function objectIdentityToken(info) {
  if (!info) return null;
  return [info.dev, info.ino, info.mode, info.birthtimeNs].map(String).join(':');
}

async function stableLstat(target) {
  return lstat(target, { bigint: true }).catch((error) =>
    error?.code === 'ENOENT' ? null : Promise.reject(error));
}

function sameStat(left, right) {
  return Boolean(left === null && right === null) || Boolean(left && right
    && statToken(left) === statToken(right));
}

async function directoryChainGuard(root, relativeDirectory, label) {
  const paths = [root];
  let cursor = root;
  for (const segment of relativeDirectory.split('/').filter(Boolean)) {
    cursor = path.join(cursor, segment);
    paths.push(cursor);
  }
  const entries = [];
  let missing = false;
  for (const target of paths) {
    const info = missing ? null : await stableLstat(target);
    if (!info) missing = true;
    if (info?.isSymbolicLink()) {
      throw new SingularityFlowError(`${label} must not contain a symbolic-link directory: ${target}`);
    }
    if (info && !info.isDirectory()) {
      throw new SingularityFlowError(`${label} must contain only directories: ${target}`);
    }
    // A directory guard protects pathname identity, not directory contents. Reset itself and
    // unrelated processes may legitimately add/remove children (notably in the system temp
    // directory), which changes size/mtime/ctime without redirecting the path. Device, inode,
    // mode, and birth time still detect replacement or a symlink swap without treating those
    // harmless child mutations as a collision.
    entries.push({ target, token: objectIdentityToken(info), exists: Boolean(info) });
  }
  return { label, entries };
}

async function assertDirectoryChainGuard(guard) {
  for (const expected of guard.entries) {
    const current = await stableLstat(expected.target);
    if (Boolean(current) !== expected.exists || objectIdentityToken(current) !== expected.token) {
      throw resetCollision(
        `${guard.label} changed while factory reset was operating. No path through the changed parent was modified.`,
        { path: expected.target, expected, current: current ? objectIdentityToken(current) : null }
      );
    }
  }
}

async function refreshRecordParentGuard(record) {
  if (!record.guardAnchor) return null;
  record.parentGuard = await directoryChainGuard(
    record.guardAnchor,
    record.guardRelative ?? '',
    record.guardLabel ?? `${record.label} parent`
  );
  return record.parentGuard;
}

async function fingerprintNode(hash, absolute, relative) {
  const info = await stableLstat(absolute);
  if (!info) { hash.update(`missing\0${relative}\0`); return; }
  if (info.isSymbolicLink()) {
    hash.update(`symlink\0${relative}\0${await readlink(absolute)}\0`);
  } else if (info.isFile()) {
    hash.update(`file\0${relative}\0${info.mode}\0${info.size}\0`);
    // Bind the open descriptor to the lstat result before reading. If the pathname or one of its
    // parents was swapped for a symlink, open may resolve elsewhere; fstat detects that different
    // inode before any outside bytes are consumed. The fixed buffer also avoids loading a large
    // runtime cache into memory merely to preview a reset.
    const handle = await open(absolute, 'r');
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameStat(info, opened)) {
        throw resetCollision(`Factory-reset file changed before ${relative} could be inspected.`, {
          path: absolute, expected: statToken(info), current: statToken(opened)
        });
      }
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const afterRead = await handle.stat({ bigint: true });
      if (!sameStat(opened, afterRead)) {
        throw resetCollision(`Factory-reset file changed while ${relative} was being inspected.`, {
          path: absolute, expected: statToken(opened), current: statToken(afterRead)
        });
      }
    } finally {
      await handle.close();
    }
    hash.update('\0');
  } else if (info.isDirectory()) {
    hash.update(`directory\0${relative}\0`);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await fingerprintNode(hash, path.join(absolute, entry.name), path.posix.join(relative, entry.name));
    }
  } else {
    hash.update(`other\0${relative}\0${info.mode}\0${info.size}\0`);
  }
  const after = await stableLstat(absolute);
  if (!sameStat(info, after)) {
    throw resetCollision(`Factory-reset scope changed while ${relative} was being inspected.`, {
      path: absolute, expected: statToken(info), current: statToken(after)
    });
  }
}

async function snapshotPath(absolute, logical) {
  const info = await stableLstat(absolute);
  const hash = createHash('sha256');
  await fingerprintNode(hash, absolute, logical);
  const after = await stableLstat(absolute);
  if (!sameStat(info, after)) {
    throw resetCollision(`Factory-reset path changed while ${logical} was being inspected.`, {
      path: absolute, expected: statToken(info), current: statToken(after)
    });
  }
  return {
    exists: Boolean(info),
    kind: !info ? 'missing'
      : info.isDirectory() ? 'directory'
        : info.isFile() ? 'file'
          : info.isSymbolicLink() ? 'symlink' : 'other',
    sha256: `sha256:${hash.digest('hex')}`,
    // Filesystem identity is intentionally an apply-time guard, not part of a portable preview.
    // A rename keeps this identity, while an editor replacement with identical bytes does not.
    identity: info ? `${info.dev}:${info.ino}:${info.birthtimeNs}` : null,
    state: statToken(info)
  };
}

function sameSnapshot(left, right, { identity = false } = {}) {
  return Boolean(left && right
    && left.exists === right.exists
    && left.kind === right.kind
    && left.sha256 === right.sha256
    && (!identity || left.identity === right.identity));
}

function resetCollision(message, details = {}) {
  return new SingularityFlowError(message, {
    code: 'FACTORY_RESET_SCOPE_CHANGED', details
  });
}

function retainedResetDataError(error, staging, runtimeBackups = []) {
  const runtimePaths = runtimeBackups
    .filter((runtime) => runtime.moved)
    .map((runtime) => runtime.backup);
  const retainedPaths = [...new Set([staging, ...runtimePaths])];
  return new SingularityFlowError(
    `${error.message} Recovery data was retained at ${retainedPaths.join(', ')}.`,
    {
      code: error?.code ?? 'FACTORY_RESET_SCOPE_CHANGED',
      details: {
        ...(error?.details && typeof error.details === 'object' ? error.details : {}),
        staging,
        ...(runtimePaths.length ? { runtimeBackups: runtimePaths } : {}),
        retainedPaths,
        originalError: error?.message ?? String(error)
      },
      cause: error
    }
  );
}

async function stageVerifiedMove(record, { fault = null, stage = null } = {}) {
  if (record.parentGuard) await assertDirectoryChainGuard(record.parentGuard);
  const current = await snapshotPath(record.current, record.logical);
  if (!sameSnapshot(current, record.before, { identity: true })) {
    throw resetCollision(
      `Factory-reset path changed after final validation: ${record.label}. Nothing else was removed.`,
      { path: record.current, expected: record.before, current }
    );
  }
  if (!current.exists) return;
  if (fault && stage) await fault(`${stage}:before-rename`);
  if (record.parentGuard) await assertDirectoryChainGuard(record.parentGuard);
  const immediatelyBeforeMove = await snapshotPath(record.current, record.logical);
  if (!sameSnapshot(current, immediatelyBeforeMove, { identity: true })) {
    throw resetCollision(
      `Factory-reset path changed immediately before it was staged: ${record.label}.`,
      { path: record.current, expected: current, current: immediatelyBeforeMove }
    );
  }
  await mkdir(path.dirname(record.backup), { recursive: true });
  await rename(record.current, record.backup);
  // Set this before any verification: rollback is now the only operation allowed to move it back.
  record.moved = true;
  if (fault && stage) await fault(`${stage}:after-rename`);
  const moved = await snapshotPath(record.backup, record.logical);
  record.backupSnapshot = moved;
  if (!sameSnapshot(current, moved, { identity: true })) {
    throw resetCollision(
      `Factory-reset path changed while it was being staged: ${record.label}. The reset will restore the latest bytes.`,
      { path: record.current, backup: record.backup, expected: current, current: moved }
    );
  }
}

async function withdrawOwnedReplacement(record, staging, { fault = null, stage = null } = {}) {
  if (record.parentGuard) await assertDirectoryChainGuard(record.parentGuard);
  const current = await snapshotPath(record.current, record.logical);
  if (!current.exists) return;
  if (!record.replacementInstalled
      || !sameSnapshot(current, record.installedSnapshot, { identity: true })) {
    throw resetCollision(
      `Rollback preserved a concurrently changed path instead of deleting it: ${record.label}.`,
      { path: record.current, expected: record.installedSnapshot ?? null, current }
    );
  }
  const withdrawn = path.join(staging, 'rollback-replacements', `${randomUUID()}-${path.basename(record.current)}`);
  await mkdir(path.dirname(withdrawn), { recursive: true });
  if (fault && stage) await fault(`${stage}:before-withdraw`);
  if (record.parentGuard) await assertDirectoryChainGuard(record.parentGuard);
  const immediatelyBeforeMove = await snapshotPath(record.current, record.logical);
  if (!sameSnapshot(current, immediatelyBeforeMove, { identity: true })) {
    throw resetCollision(`Rollback preserved a concurrently changed replacement: ${record.label}.`, {
      path: record.current, expected: current, current: immediatelyBeforeMove
    });
  }
  await rename(record.current, withdrawn);
  record.withdrawnReplacement = withdrawn;
  const moved = await snapshotPath(withdrawn, record.logical);
  if (!sameSnapshot(current, moved, { identity: true })) {
    // A write through an already-open handle raced the rename. Put those latest bytes back only if
    // the original path is still vacant; never overwrite another writer while repairing rollback.
    const replacement = await snapshotPath(record.current, record.logical);
    if (!replacement.exists) {
      await rename(withdrawn, record.current);
      record.withdrawnReplacement = null;
    }
    throw resetCollision(
      `Rollback could not prove ownership of the moved replacement for ${record.label}; concurrent bytes were preserved.`,
      { path: record.current, retained: record.withdrawnReplacement ?? record.current }
    );
  }
  record.withdrawnSnapshot = moved;
}

/** Restore only bytes this reset staged; never delete a path that appeared concurrently. */
async function restoreDirectory(record, staging, { fault = null, stage = null } = {}) {
  if (!record.moved && !record.replacementInstalled) return;
  await withdrawOwnedReplacement(record, staging, { fault, stage });
  if (!record.moved) return;
  await refreshRecordParentGuard(record);
  if (record.parentGuard) await assertDirectoryChainGuard(record.parentGuard);
  const occupied = await snapshotPath(record.current, record.logical);
  if (occupied.exists) {
    throw resetCollision(
      `Rollback left both versions intact because ${record.label} was recreated concurrently.`,
      { path: record.current, backup: record.backup, current: occupied }
    );
  }
  if (fault && stage) await fault(`${stage}:before-restore`);
  if (record.parentGuard) await assertDirectoryChainGuard(record.parentGuard);
  const occupiedAtRename = await snapshotPath(record.current, record.logical);
  if (occupiedAtRename.exists) {
    throw resetCollision(
      `Rollback did not replace a concurrently created path for ${record.label}.`,
      { path: record.current, backup: record.backup, current: occupiedAtRename }
    );
  }
  // Re-snapshot immediately before restore. If an old process wrote through an open handle after
  // the move, those newest bytes are the ones rollback must put back. `rename()` is deliberately
  // not used here: on supported filesystems it may replace a concurrently-created empty directory
  // after the vacancy check. Reserving the destination with exclusive mkdir and copying with
  // no-overwrite semantics makes that race fail closed.
  const latestBackup = await snapshotPath(record.backup, record.logical);
  if (fault && stage) await fault(`${stage}:before-publication`);
  if (record.parentGuard) await assertDirectoryChainGuard(record.parentGuard);
  try {
    await mkdir(record.current, { recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw resetCollision(
        `Rollback did not replace a concurrently created directory for ${record.label}.`,
        { path: record.current, backup: record.backup }
      );
    }
    throw error;
  }
  for (const entry of await readdir(record.backup)) {
    await cp(path.join(record.backup, entry), path.join(record.current, entry), {
      recursive: true, force: false, errorOnExist: true, preserveTimestamps: true
    });
  }
  const restored = await snapshotPath(record.current, record.logical);
  if (!sameSnapshot(latestBackup, restored)) {
    throw resetCollision(
      `Rollback restored ${record.label}, but its bytes changed concurrently; inspect it before retrying.`,
      { path: record.current, expected: latestBackup, current: restored }
    );
  }
  if (fault && stage) await fault(`${stage}:before-backup-cleanup`);
  const finalBackup = await snapshotPath(record.backup, record.logical);
  const finalRestored = await snapshotPath(record.current, record.logical);
  if (!sameSnapshot(latestBackup, finalBackup, { identity: true })
      || !sameSnapshot(finalBackup, finalRestored)) {
    throw resetCollision(
      `Rollback retained the staged directory because ${record.label} changed before cleanup.`,
      {
        path: record.current, backup: record.backup, expected: latestBackup,
        backupCurrent: finalBackup, current: finalRestored
      }
    );
  }
  await rm(record.backup, { recursive: true, force: true });
  record.moved = false;
}

async function restoreSymlinkNoReplace(saved, target, logical, {
  fault = null,
  stage = null,
  parentGuard = null
} = {}) {
  if (parentGuard) await assertDirectoryChainGuard(parentGuard);
  const occupied = await snapshotPath(target, logical);
  if (occupied.exists) {
    throw resetCollision(`Rollback did not overwrite a concurrently created path: ${logical}.`, {
      path: target, backup: saved, current: occupied
    });
  }
  if (fault && stage) await fault(`${stage}:before-restore`);
  if (parentGuard) await assertDirectoryChainGuard(parentGuard);
  const occupiedAtPublish = await snapshotPath(target, logical);
  if (occupiedAtPublish.exists) {
    throw resetCollision(`Rollback did not overwrite a concurrently created path: ${logical}.`, {
      path: target, backup: saved, current: occupiedAtPublish
    });
  }
  const before = await snapshotPath(saved, logical);
  const linkTarget = await readlink(saved);
  if (fault && stage) await fault(`${stage}:before-publication`);
  if (parentGuard) await assertDirectoryChainGuard(parentGuard);
  await symlink(linkTarget, target);
  const restored = await snapshotPath(target, logical);
  if (!sameSnapshot(before, restored)) {
    throw resetCollision(`Rollback could not verify the restored symbolic link ${logical}.`, {
      path: target, backup: saved, expected: before, current: restored
    });
  }
  if (fault && stage) await fault(`${stage}:before-backup-cleanup`);
  const latestSaved = await snapshotPath(saved, logical);
  const latestRestored = await snapshotPath(target, logical);
  if (!sameSnapshot(before, latestSaved, { identity: true })
      || !sameSnapshot(latestSaved, latestRestored)) {
    throw resetCollision(
      `Rollback retained the staged symbolic link because ${logical} changed before cleanup.`,
      { path: target, backup: saved, expected: before, backupCurrent: latestSaved, current: latestRestored }
    );
  }
  await rm(saved, { force: true });
}

async function restoreFileNoReplace(saved, target, logical, {
  fault = null,
  stage = null,
  forceCopy = false,
  parentGuard = null
} = {}) {
  if (parentGuard) await assertDirectoryChainGuard(parentGuard);
  const occupied = await snapshotPath(target, logical);
  if (occupied.exists) {
    throw resetCollision(`Rollback did not overwrite a concurrently created file: ${logical}.`, {
      path: target, backup: saved, current: occupied
    });
  }
  if (fault && stage) await fault(`${stage}:before-restore`);
  if (parentGuard) await assertDirectoryChainGuard(parentGuard);
  const occupiedAtPublish = await snapshotPath(target, logical);
  if (occupiedAtPublish.exists) {
    throw resetCollision(`Rollback did not overwrite a concurrently created file: ${logical}.`, {
      path: target, backup: saved, current: occupiedAtPublish
    });
  }
  // Hard-link publication is no-replace and retains the original inode/hard-link relationship.
  // Some supported corporate/network filesystems reject links; exclusive copy is the safe fallback.
  let linked = false;
  const before = await snapshotPath(saved, logical);
  if (fault && stage) await fault(`${stage}:before-publication`);
  if (parentGuard) await assertDirectoryChainGuard(parentGuard);
  if (!forceCopy) {
    try {
      await link(saved, target);
      linked = true;
    } catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL']
        .includes(error?.code)) throw error;
    }
  }
  if (!linked) await cp(saved, target, { force: false, errorOnExist: true });
  const restored = await snapshotPath(target, logical);
  if (!sameSnapshot(before, restored, { identity: linked })) {
    throw resetCollision(`Rollback could not verify the restored file ${logical}.`, {
      path: target, backup: saved, expected: before, current: restored
    });
  }
  if (fault && stage) await fault(`${stage}:before-backup-cleanup`);
  const latestSaved = await snapshotPath(saved, logical);
  const latestRestored = await snapshotPath(target, logical);
  if (!sameSnapshot(before, latestSaved, { identity: true })
      || !sameSnapshot(latestSaved, latestRestored, { identity: linked })) {
    throw resetCollision(
      `Rollback retained the staged copy because ${logical} changed before cleanup.`,
      { path: target, backup: saved, expected: before, backupCurrent: latestSaved, current: latestRestored }
    );
  }
  await rm(saved, { force: true });
}

async function restoreStagedFile(record, staging, options = {}) {
  if (!record.moved && !record.replacementInstalled) return;
  await withdrawOwnedReplacement(record, staging, options);
  if (!record.moved) return;
  await refreshRecordParentGuard(record);
  await restoreFileNoReplace(record.backup, record.current, record.logical, {
    ...options, parentGuard: record.parentGuard
  });
  record.moved = false;
}

async function resetScopeFingerprint(root, entries, identity, {
  relativePaths = [],
  absolutePaths = [],
  identityPaths = [],
  packageVersion = null
} = {}) {
  const hash = createHash('sha256');
  hash.update('factory-reset-scope-v2\0');
  hash.update(`repository\0${root}\0branch\0${identity.branch ?? 'detached'}\0`);
  hash.update(`head\0${identity.head ?? 'unborn'}\0package\0${packageVersion ?? 'unknown'}\0`);
  for (const absolute of [...new Set(identityPaths)].sort()) {
    const info = await stableLstat(absolute);
    hash.update(`identity\0${absolute}\0${objectIdentityToken(info) ?? 'missing'}\0`);
  }
  for (const entry of entries) {
    hash.update(`${entry.status}\0${entry.currentPath}\0${entry.originalPath ?? ''}\0`);
    const current = await snapshotPath(path.join(root, entry.currentPath), entry.currentPath);
    hash.update(`${current.sha256}\0${current.identity ?? 'missing'}\0${current.state ?? 'missing'}\0`);
    if (entry.originalPath && entry.originalPath !== entry.currentPath) {
      const original = await snapshotPath(path.join(root, entry.originalPath), entry.originalPath);
      hash.update(`${original.sha256}\0${original.identity ?? 'missing'}\0${original.state ?? 'missing'}\0`);
    }
  }
  for (const relative of [...new Set(relativePaths)].sort()) {
    hash.update(`extra\0${relative}\0`);
    const snapshot = await snapshotPath(path.join(root, ...relative.split('/')), relative);
    hash.update(`${snapshot.sha256}\0${snapshot.identity ?? 'missing'}\0${snapshot.state ?? 'missing'}\0`);
  }
  for (const entry of [...absolutePaths].sort((left, right) =>
    left.logical.localeCompare(right.logical) || left.absolute.localeCompare(right.absolute))) {
    const snapshot = await snapshotPath(entry.absolute, entry.logical);
    hash.update(`absolute\0${entry.logical}\0${entry.absolute}\0${snapshot.sha256}\0`);
    hash.update(`${snapshot.identity ?? 'missing'}\0${snapshot.state ?? 'missing'}\0`);
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Prove which non-packaged Agent Markdown files can coexist with the newly installed definition.
 *
 * A factory reset must be able to recover a repository whose active custom-agent file is malformed,
 * but silently deleting that file would contradict the reset's preservation contract. Build the
 * exact packaged definition in an isolated directory and add custom files one at a time. Files that
 * make the resulting catalog invalid are assigned a content-addressed recovery path outside
 * `.github/agents`, where Copilot and SFlow will not discover them as active agents.
 */
async function customAgentRecoveryPlan(repository, { caseInsensitive }) {
  const sourceRoot = path.join(repository, '.github', 'agents');
  const packaged = new Set((await regularFiles(PACKAGED_AGENTS_ROOT)).map((relative) =>
    comparableRepositoryPath(relative, caseInsensitive)));
  const candidates = (await readdir(sourceRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }))
    .filter((entry) => entry.isFile() && /(?:\.agent)?\.md$/i.test(entry.name)
      && !packaged.has(comparableRepositoryPath(entry.name, caseInsensitive)))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (!candidates.length) return [];
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-agent-check-'));
  try {
    await initializeDefinition(sandbox);
    await loadDefinition(sandbox);
    const sandboxAgents = path.join(sandbox, '.github', 'agents');
    const recoveries = [];
    for (const name of candidates) {
      const sourcePath = path.join(sourceRoot, name);
      const candidatePath = path.join(sandboxAgents, name);
      const relativeSource = path.posix.join('.github/agents', name);
      const sourceSnapshot = await snapshotPath(sourcePath, relativeSource);
      const bytes = await readFile(sourcePath);
      const sourceAfterRead = await snapshotPath(sourcePath, relativeSource);
      if (!sameSnapshot(sourceSnapshot, sourceAfterRead, { identity: true })) {
        throw resetCollision(`Custom agent changed while its reset plan was being prepared: ${relativeSource}.`, {
          path: sourcePath, expected: sourceSnapshot, current: sourceAfterRead
        });
      }
      await writeFile(candidatePath, bytes, { flag: 'wx' });
      try {
        await loadDefinition(sandbox);
      } catch (error) {
        await rm(candidatePath, { force: true });
        // If removing the candidate does not restore a valid packaged-plus-custom catalog, the
        // isolation result is not trustworthy and the reset must stop without touching the repo.
        await loadDefinition(sandbox);
        const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        const recoveryPath = path.posix.join(
          RECOVERED_AGENTS_ROOT, sha256.slice('sha256:'.length), name
        );
        const rawReason = String(error?.message ?? error)
          .replaceAll(sandbox.split(path.sep).join('/'), '<validation-sandbox>')
          .replaceAll(sandbox, '<validation-sandbox>')
          .slice(0, 2000);
        const reason = visibleGitPath(rawReason).slice(1, -1);
        await assertSafeDirectoryChain(
          repository, path.posix.dirname(recoveryPath), 'Recovered custom-agent target'
        );
        const existing = await lstat(path.join(repository, ...recoveryPath.split('/'))).catch(
          (failure) => failure?.code === 'ENOENT' ? null : Promise.reject(failure)
        );
        if (existing && !existing.isFile()) {
          throw new SingularityFlowError(
            `Recovered custom-agent target must be a regular file: ${visibleGitPath(recoveryPath)}`
          );
        }
        if (existing && !(await readFile(path.join(repository, ...recoveryPath.split('/')))).equals(bytes)) {
          throw new SingularityFlowError(
            `Recovered custom-agent target does not contain the expected ${sha256} bytes: ${visibleGitPath(recoveryPath)}`
          );
        }
        recoveries.push({
          sourcePath: relativeSource,
          recoveryPath,
          sourceDisplay: visibleGitPath(relativeSource),
          recoveryDisplay: visibleGitPath(recoveryPath),
          sha256,
          bytes: bytes.length,
          reason,
          sourceSnapshot
        });
      }
    }
    return recoveries;
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

export async function factoryResetPlan(root, { packageVersion = null } = {}) {
  const repository = await realpath(path.resolve(root));
  const caseInsensitive = repositoryCaseInsensitive(repository);
  // Git may spell one directory through a filesystem alias (`/var` versus `/private/var` on macOS,
  // or drive-letter casing on Windows). Canonicalize before deduplicating so a normal checkout does
  // not pretend it has a second repository-shared runtime root and process the same bytes twice.
  const privateGitDirectory = await realpath(gitDir(repository));
  const commonGitDirectory = await realpath(gitCommonDir(repository));
  const sharedLocalRuntime = path.join(commonGitDirectory, LOCAL_RUNTIME_ROOT);
  const localRuntimeRoots = [...new Set([
    path.join(privateGitDirectory, LOCAL_RUNTIME_ROOT), sharedLocalRuntime
  ])];
  await directoryState(path.join(repository, 'singularity'), 'Singularity control root');
  await directoryState(path.join(repository, '.singularity'), 'Legacy Singularity control root');
  await directoryState(path.join(repository, '.sdlc'), 'Former SDLC control root');
  // Agent files are replaced in place rather than replacing the whole `.github` tree. Validate
  // both parents explicitly: lstat(target) does not reveal a symlink in one of its ancestors, and
  // following such a link would let a reset selected for this repository overwrite another tree.
  await assertSafeDirectoryChain(repository, '.github/agents', 'Bundled agent target');
  for (const localRuntime of localRuntimeRoots) {
    await directoryState(localRuntime, 'Singularity local runtime root');
  }
  // The token binds to this checkout at this commit, not just to its name. `RESET <name>` alone is
  // derivable from the directory you are standing in, so a token copied out of shell history — or
  // computed by an agent that never showed anybody the preview — matched a different clone of the
  // same repository just as happily as the one it was produced for.
  const identity = repositoryIdentity(repository);
  const revision = identity.head;
  const confirmation = `RESET ${path.basename(repository)} ${revision ? revision.slice(0, 7) : 'unborn'}`;
  const uncommittedEntries = changedResetEntries(repository, { caseInsensitive });
  const uncommittedResetPaths = uncommittedEntries.map((entry) => entry.display);
  const packagedAgentSources = new Map((await regularFiles(PACKAGED_AGENTS_ROOT)).map((relative) => [
    path.posix.join('.github/agents', relative.split(path.sep).join('/')),
    path.join(PACKAGED_AGENTS_ROOT, relative)
  ]));
  const changedPackagedAgents = new Set();
  for (const [normalized, source] of packagedAgentSources) {
    const target = path.join(repository, ...normalized.split('/'));
    const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    // A deletion loses no uncommitted bytes; the reset simply restores the packaged file. An
    // identical untracked file is likewise not a discard. Any other target is explicitly named.
    if (!info) continue;
    if (!info.isFile()) changedPackagedAgents.add(normalized);
    else if (!(await readFile(target)).equals(await readFile(source))) changedPackagedAgents.add(normalized);
  }
  const uncommittedDiscardPaths = new Set();
  for (const entry of uncommittedEntries) {
    if (controlRootPath(entry.currentPath, caseInsensitive)
      || (entry.originalPath && controlRootPath(entry.originalPath, caseInsensitive))) {
      uncommittedDiscardPaths.add(entry.display);
    }
    // Git aggregates ignored directories even with --untracked-files=all. Expand an aggregate such
    // as `!! .github/agents/` to the exact packaged targets whose bytes differ, so the editor cannot
    // silently overwrite ignored private content without explicitly accepting that discard.
    for (const agentPath of changedPackagedAgents) {
      const covered = repositoryPathCovers(entry.currentPath, agentPath, caseInsensitive)
        || (entry.originalPath && repositoryPathCovers(entry.originalPath, agentPath, caseInsensitive));
      if (!covered) continue;
      uncommittedDiscardPaths.add(repositoryPathCovers(agentPath, entry.currentPath, caseInsensitive)
        ? entry.display
        : `${entry.status} ${agentPath} (reported by Git as ${entry.currentPath})`);
    }
  }
  const customAgentRecoveries = await customAgentRecoveryPlan(repository, { caseInsensitive });
  const resetScopeSha256 = await resetScopeFingerprint(repository, uncommittedEntries, identity, {
    packageVersion,
    identityPaths: [repository, privateGitDirectory, commonGitDirectory],
    relativePaths: [
      ...CONTROL_ROOTS,
      ...packagedAgentSources.keys(),
      ...customAgentRecoveries.flatMap((entry) => [entry.sourcePath, entry.recoveryPath])
    ],
    absolutePaths: localRuntimeRoots.map((absolute, index) => ({
      absolute,
      logical: `repository-runtime-${index + 1}`
    }))
  });
  return {
    schemaVersion: 1,
    operation: 'factory-reset',
    repository,
    branch: identity.branch,
    head: revision,
    packageVersion,
    confirmation,
    remove: [
      'singularity/ (workflow, lifecycle state, generated artifacts, templates, prompts, and world model)',
      '.singularity/ (legacy configuration, when present)',
      '.sdlc/ (former legacy configuration, when present)',
      ...localRuntimeRoots.map((localRuntime) => `${localRuntime} (`
        + `${localRuntimeRoots.length > 1 && localRuntime === sharedLocalRuntime
          ? 'repository-shared runtime for all linked worktrees: ' : ''}`
        + 'sessions, choices, locks, telemetry, caches, and pending-publication recovery)')
    ],
    replace: [
      'singularity/ from the templates bundled with the currently installed npm package',
      'bundled .github/agents/*.agent.md files from that package'
    ],
    preserve: [
      'application source and every file outside the listed reset roots',
      '.git history, branches, tags, remotes, index, and configuration',
      'valid custom .github/agents files whose names are not supplied by the npm package remain active in place',
      `invalid custom Agent Markdown is preserved byte-for-byte under ${RECOVERED_AGENTS_ROOT}/ and removed from active agent discovery`,
      'the global workspace registry and workspace clones'
    ],
    localRuntimeRoots,
    resetScopeSha256,
    uncommittedResetPaths,
    uncommittedDiscardPaths: [...uncommittedDiscardPaths],
    customAgentRecoveries
  };
}

/**
 * @param fault test seam for crash-point injection, matching the publication kernel's. Rollback is
 *   the whole point of this command and it is unreachable from a CLI test without one.
 */
async function factoryResetRepositoryLocked(root, {
  confirmation,
  packageVersion = null,
  allowDirty = false,
  expectedScopeSha256 = null,
  fault = null,
  forceCopyRestore = false
} = {}) {
  const plan = await factoryResetPlan(root, { packageVersion });
  if (expectedScopeSha256 && expectedScopeSha256 !== plan.resetScopeSha256) {
    throw new SingularityFlowError(
      `Factory-reset scope changed after preview (expected ${expectedScopeSha256}, current ${plan.resetScopeSha256}). `
      + 'Nothing was removed. Preview and confirm the current reset boundary again.'
    );
  }
  if (confirmation !== plan.confirmation) {
    throw new SingularityFlowError(
      `Factory reset requires exact confirmation '${plan.confirmation}'. Run with --dry-run first, then pass --confirm ${JSON.stringify(plan.confirmation)}.`
    );
  }
  // Refused rather than warned about. These paths were computed, printed after the reset had
  // already discarded them, and never checked — and "Git history is the recovery path" is exactly
  // the claim that does not hold for them.
  //
  // Scoped to the control roots, which are the trees this command deletes outright. `.github/agents`
  // is in the reported set because a customised packaged agent is overwritten, but a freshly
  // initialised repository has that directory untracked with the packaged content already in it,
  // and refusing there would block the reset on files identical to what it is about to write.
  const discarded = plan.uncommittedDiscardPaths;
  if (!allowDirty && discarded.length) {
    throw new SingularityFlowError(
      'Factory reset would discard uncommitted changes that Git cannot recover:\n'
      + discarded.map((item) => `  ${item}`).join('\n')
      + '\nCommit or stash them, or pass --allow-dirty to discard them deliberately.'
    );
  }

  const repository = plan.repository;
  // Stage worktree-owned roots on the worktree filesystem. A linked worktree can live on a different
  // Windows drive or mount from its common Git directory; staging under gitDir made every rename
  // fail with EXDEV. The reset barrier prevents governed work while this short-lived, mode-0700
  // directory exists, and a failed cleanup names it explicitly.
  const staging = await mkdtemp(path.join(repository, '.sflow-factory-reset-'));
  const fresh = path.join(staging, 'fresh');
  const backup = path.join(staging, 'backup');
  const control = path.join(repository, 'singularity');
  const legacy = path.join(repository, '.singularity');
  const former = path.join(repository, '.sdlc');
  const backupControl = path.join(backup, 'singularity');
  const backupLegacy = path.join(backup, '.singularity');
  const backupFormer = path.join(backup, '.sdlc');
  const freshAgents = path.join(fresh, '.github', 'agents');
  const targetAgents = path.join(repository, '.github', 'agents');
  const backupAgents = path.join(backup, 'agents');
  const localRuntimeRoots = plan.localRuntimeRoots
    ?? [path.join(gitDir(repository), LOCAL_RUNTIME_ROOT)];
  const controlRecords = [
    { label: 'singularity/', logical: 'singularity', current: control, backup: backupControl,
      moved: false, replacementInstalled: false, guardAnchor: repository, guardRelative: '' },
    { label: '.singularity/', logical: '.singularity', current: legacy, backup: backupLegacy,
      moved: false, replacementInstalled: false, guardAnchor: repository, guardRelative: '' },
    { label: '.sdlc/', logical: '.sdlc', current: former, backup: backupFormer,
      moved: false, replacementInstalled: false, guardAnchor: repository, guardRelative: '' }
  ];
  const [controlRecord] = controlRecords;
  const runtimeBackups = localRuntimeRoots.map((current, index) => ({
    label: `repository-local SFlow runtime ${index + 1}`,
    logical: `repository-runtime-${index + 1}`,
    current,
    // Each runtime is staged beside itself so rename remains atomic even when private/common Git
    // directories or the working tree are on different filesystems.
    backup: path.join(path.dirname(current),
      `.${path.basename(current)}-factory-reset-${index}-${randomUUID()}`),
    moved: false,
    replacementInstalled: false,
    guardAnchor: path.dirname(current),
    guardRelative: ''
  }));
  const agentBackups = [];
  const recoveredAgents = [];
  let installedAgents = [];
  let completed = false;
  let restoreFailed = false;
  let successResult = null;
  let operationError = null;

  try {
    await mkdir(fresh, { recursive: true });
    await initializeDefinition(fresh);
    await loadDefinition(fresh);
    installedAgents = await regularFiles(freshAgents);
    await mkdir(backup, { recursive: true });
    if (fault) await fault('after-fresh-install');

    // Resolve every path state that the moves need before the final scope validation. Keeping
    // fallible filesystem reads out of the validation-to-first-rename interval makes that interval
    // as small as the filesystem API permits. The preview/apply digest is checked at entry, but
    // template preparation takes time and an IDE save or legacy SFlow binary does not necessarily
    // observe the reset barrier. Recompute the complete branch/HEAD/dirty-byte fingerprint
    // immediately before the first move and refuse if anything changed. A second active-lock scan
    // catches older binaries that do not know about the barrier yet.
    for (const record of [...controlRecords, ...runtimeBackups]) {
      record.before = await snapshotPath(record.current, record.logical);
    }
    const freshControl = path.join(fresh, 'singularity');
    const freshControlSnapshot = await snapshotPath(freshControl, controlRecord.logical);
    if (!freshControlSnapshot.exists || freshControlSnapshot.kind !== 'directory') {
      throw new SingularityFlowError('The packaged factory-reset definition did not create singularity/.');
    }
    for (const relative of installedAgents) {
      const normalizedRelative = relative.split(path.sep).join('/');
      if (normalizedRelative === '..' || normalizedRelative.startsWith('../')) {
        throw new SingularityFlowError(`Bundled agent path escapes its target root: ${relative}`);
      }
      const target = path.join(targetAgents, relative);
      agentBackups.push({
        label: path.posix.join('.github/agents', normalizedRelative),
        logical: path.posix.join('.github/agents', normalizedRelative),
        relative,
        source: path.join(freshAgents, relative),
        current: target,
        backup: path.join(backupAgents, relative),
        before: await snapshotPath(target, path.posix.join('.github/agents', normalizedRelative)),
        moved: false,
        replacementInstalled: false,
        guardAnchor: repository,
        guardRelative: path.posix.dirname(path.posix.join('.github/agents', normalizedRelative))
      });
    }
    if (fault) await fault('before-final-scope-validation');
    await assertNoActiveSubjectLocks(repository);
    const finalPlan = await factoryResetPlan(repository, { packageVersion });
    if (finalPlan.resetScopeSha256 !== plan.resetScopeSha256) {
      throw new SingularityFlowError(
        `Factory-reset scope changed during preparation (expected ${plan.resetScopeSha256}, current ${finalPlan.resetScopeSha256}). `
        + 'Nothing was removed. Preview and confirm the current reset boundary again.'
      );
    }
    if (fault) await fault('after-final-scope-validation');

    for (const record of controlRecords) {
      await refreshRecordParentGuard(record);
      await stageVerifiedMove(record, { fault, stage: `control-root:${record.logical}` });
    }
    if (fault) await fault('after-control-roots-move');
    // The fresh tree and target live on the same worktree filesystem, so publication can be one
    // atomic rename. A concurrently recreated target makes rename fail instead of merging trees.
    const controlInstallGuard = await directoryChainGuard(repository, '', 'singularity/ install parent');
    if (fault) await fault('before-control-install');
    await assertDirectoryChainGuard(controlInstallGuard);
    const currentFreshControl = await snapshotPath(freshControl, controlRecord.logical);
    if (!sameSnapshot(currentFreshControl, freshControlSnapshot, { identity: true })) {
      throw resetCollision('The packaged singularity/ tree changed before it was installed.', {
        path: freshControl, expected: freshControlSnapshot, current: currentFreshControl
      });
    }
    controlRecord.installedSnapshot = freshControlSnapshot;
    await rename(freshControl, control);
    controlRecord.replacementInstalled = true;
    if (fault) await fault('after-control-install-before-validation');
    const installedControl = await snapshotPath(control, controlRecord.logical);
    if (!sameSnapshot(freshControlSnapshot, installedControl, { identity: true })) {
      throw resetCollision('The packaged singularity/ tree changed while it was installed.', {
        path: control, expected: freshControlSnapshot, current: installedControl
      });
    }
    if (fault) await fault('after-control-install');

    for (const record of agentBackups) {
      const { source, current: target, relative } = record;
      const normalizedRelative = relative.split(path.sep).join('/');
      const nestedParent = path.posix.dirname(normalizedRelative);
      await assertSafeDirectoryChain(repository, path.posix.join(
        '.github/agents', nestedParent === '.' ? '' : nestedParent
      ), 'Bundled agent target');
      if (record.before.exists && record.before.kind !== 'file') {
        throw new SingularityFlowError(`Bundled agent target must be a regular file: ${target}`);
      }
      record.guardLabel = `Bundled agent target ${record.label}`;
      await refreshRecordParentGuard(record);
      await stageVerifiedMove(record, { fault, stage: `packaged-agent:${normalizedRelative}` });
      await assertSafeDirectoryChain(
        repository, path.posix.dirname(record.logical), `Bundled agent target ${record.label}`
      );
      await ensureSafeDirectoryChain(
        repository, path.posix.dirname(record.logical), `Bundled agent target ${record.label}`
      );
      const installGuard = await directoryChainGuard(
        repository,
        path.posix.dirname(record.logical),
        `Bundled agent install ${record.label}`
      );
      const sourceSnapshot = await snapshotPath(source, record.logical);
      if (fault) await fault(`packaged-agent:${normalizedRelative}:before-install`);
      await assertDirectoryChainGuard(installGuard);
      const sourceBeforeInstall = await snapshotPath(source, record.logical);
      if (!sameSnapshot(sourceSnapshot, sourceBeforeInstall, { identity: true })) {
        throw resetCollision(`The packaged agent source changed before installation: ${record.label}.`, {
          path: source, expected: sourceSnapshot, current: sourceBeforeInstall
        });
      }
      await cp(source, target, { force: false, errorOnExist: true });
      record.replacementInstalled = true;
      if (fault) await fault(`packaged-agent:${normalizedRelative}:after-install-before-validation`);
      const installed = await snapshotPath(target, record.logical);
      if (!sameSnapshot(sourceSnapshot, installed)) {
        throw resetCollision(`The packaged agent could not be verified after installation: ${record.label}.`, {
          path: target, expected: sourceSnapshot, current: installed
        });
      }
      // Assign rollback ownership only after the observed target matched the known packaged bytes.
      // A writer that wins between copy and snapshot is preserved instead of being blessed/deleted.
      record.installedSnapshot = installed;
    }
    if (fault) await fault('after-packaged-agents-install');

    // A malformed non-packaged custom agent used to make the new definition fail here, rolling the
    // whole reset back and leaving an old repository impossible to recover. Preserve its exact
    // bytes outside the active discovery root before validation. Content-addressing makes a retry
    // idempotent and prevents one recovery from overwriting another file with the same name.
    for (const recovery of finalPlan.customAgentRecoveries ?? []) {
      const source = path.join(repository, ...recovery.sourcePath.split('/'));
      const target = path.join(repository, ...recovery.recoveryPath.split('/'));
      const record = {
        ...recovery,
        label: recovery.sourcePath,
        logical: recovery.sourcePath,
        current: source,
        backup: path.join(backup, 'recovered-agent-sources', recovery.sha256.slice(7), path.basename(source)),
        moved: false,
        replacementInstalled: false,
        targetCreated: false,
        targetRecord: null
      };
      record.guardAnchor = repository;
      record.guardRelative = path.posix.dirname(recovery.sourcePath);
      record.guardLabel = 'Recovered custom-agent source';
      recoveredAgents.push(record);
      await refreshRecordParentGuard(record);
      record.before = await snapshotPath(source, recovery.sourcePath);
      if (!sameSnapshot(record.before, recovery.sourceSnapshot, { identity: true })) {
        throw resetCollision(
          `Custom agent changed after the reset boundary was validated: ${recovery.sourceDisplay}`,
          { path: source, expected: recovery.sourceSnapshot, current: record.before }
        );
      }
      // Stage the source first. Recovery is then copied from the verified, private inode rather
      // than from an active path an editor can replace between the read and the copy.
      await stageVerifiedMove(record, {
        fault, stage: `custom-agent-source:${recovery.sha256.slice(7, 19)}`
      });
      const sourceBytes = await readFile(record.backup);
      const actualSha256 = `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`;
      if (actualSha256 !== recovery.sha256 || sourceBytes.length !== recovery.bytes) {
        throw resetCollision(
          `Custom agent changed while it was staged for recovery: ${recovery.sourceDisplay}`,
          { path: source, backup: record.backup }
        );
      }
      await assertSafeDirectoryChain(
        repository, path.posix.dirname(recovery.recoveryPath), 'Recovered custom-agent target'
      );
      const existing = await snapshotPath(target, recovery.recoveryPath);
      if (existing.exists) {
        if (existing.kind !== 'file' || !(await readFile(target)).equals(sourceBytes)) {
          throw new SingularityFlowError(
            `Recovered custom-agent target is not the expected ${recovery.sha256} file: ${recovery.recoveryDisplay}`
          );
        }
        const verifiedExisting = await snapshotPath(target, recovery.recoveryPath);
        if (!sameSnapshot(existing, verifiedExisting, { identity: true })) {
          throw resetCollision(`Recovered custom-agent target changed during validation: ${recovery.recoveryDisplay}.`, {
            path: target, expected: existing, current: verifiedExisting
          });
        }
        record.recoverySnapshot = verifiedExisting;
      } else {
        await ensureSafeDirectoryChain(
          repository, path.posix.dirname(recovery.recoveryPath), 'Recovered custom-agent target'
        );
        const targetGuard = await directoryChainGuard(
          repository, path.posix.dirname(recovery.recoveryPath), 'Recovered custom-agent target'
        );
        const backupSnapshot = await snapshotPath(record.backup, recovery.sourcePath);
        if (fault) await fault(`custom-agent-recovery:${recovery.sha256.slice(7, 19)}:before-install`);
        await assertDirectoryChainGuard(targetGuard);
        const backupBeforeInstall = await snapshotPath(record.backup, recovery.sourcePath);
        if (!sameSnapshot(backupSnapshot, backupBeforeInstall, { identity: true })) {
          throw resetCollision(`Staged custom-agent bytes changed before recovery installation: ${recovery.sourceDisplay}.`, {
            path: record.backup, expected: backupSnapshot, current: backupBeforeInstall
          });
        }
        await cp(record.backup, target, { force: false, errorOnExist: true });
        record.targetCreated = true;
        if (fault) {
          await fault(`custom-agent-recovery:${recovery.sha256.slice(7, 19)}:after-install-before-validation`);
        }
        const installedComparable = await snapshotPath(target, recovery.sourcePath);
        if (!sameSnapshot(backupSnapshot, installedComparable)) {
          throw resetCollision(`Recovered custom-agent copy could not be verified: ${recovery.recoveryDisplay}.`, {
            path: target, expected: backupSnapshot, current: installedComparable
          });
        }
        const installed = await snapshotPath(target, recovery.recoveryPath);
        // As with packaged agents, rollback ownership begins only after known bytes were observed.
        record.targetRecord = {
          label: recovery.recoveryPath,
          logical: recovery.recoveryPath,
          current: target,
          moved: false,
          replacementInstalled: true,
          installedSnapshot: installed,
          parentGuard: targetGuard,
          guardAnchor: repository,
          guardRelative: path.posix.dirname(recovery.recoveryPath),
          guardLabel: 'Recovered custom-agent target'
        };
        record.recoverySnapshot = installed;
      }
    }
    if (fault && recoveredAgents.length) await fault('after-custom-agent-recovery');

    // Validate the exact files now installed in the repository before removing the old local
    // runtime. The installed npm package is the source of the replacement, not the checkout's
    // previous configuration.
    await loadDefinition(repository);
    // Move runtime roots into the same recoverable staging area as configuration. Deleting one and
    // then failing on a locked second root (common on Windows, and possible with linked worktrees)
    // used to roll back configuration while silently losing the first runtime. Staging all roots
    // makes the operation atomic from the user's perspective; successful cleanup removes them.
    for (let index = 0; index < runtimeBackups.length; index += 1) {
      const runtime = runtimeBackups[index];
      await refreshRecordParentGuard(runtime);
      await stageVerifiedMove(runtime, { fault, stage: `local-runtime:${index + 1}` });
      if (fault) await fault(`after-local-runtime-move:${index + 1}`);
    }
    // One last bounded ownership check keeps an old writer with an already-open descriptor from
    // turning successful cleanup into silent loss. Any mismatch enters collision-safe rollback.
    for (const record of [...controlRecords, ...runtimeBackups].filter((item) => item.moved)) {
      const staged = await snapshotPath(record.backup, record.logical);
      if (!sameSnapshot(staged, record.backupSnapshot, { identity: true })) {
        throw resetCollision(`Staged bytes changed before factory-reset cleanup: ${record.label}.`, {
          path: record.current, backup: record.backup, expected: record.backupSnapshot, current: staged
        });
      }
    }
    const finalControl = await snapshotPath(control, controlRecord.logical);
    if (!sameSnapshot(finalControl, controlRecord.installedSnapshot, { identity: true })) {
      throw resetCollision('The installed singularity/ tree changed before factory-reset completion.', {
        path: control, expected: controlRecord.installedSnapshot, current: finalControl
      });
    }
    for (const record of controlRecords.slice(1)) {
      const current = await snapshotPath(record.current, record.logical);
      if (current.exists) throw resetCollision(
        `${record.label} was recreated before factory-reset completion; its bytes were preserved.`,
        { path: record.current, current }
      );
    }
    for (const runtime of runtimeBackups) {
      const current = await snapshotPath(runtime.current, runtime.logical);
      if (current.exists) throw resetCollision(
        `${runtime.label} was recreated before factory-reset completion; its bytes were preserved.`,
        { path: runtime.current, current }
      );
    }
    for (const record of agentBackups) {
      const current = await snapshotPath(record.current, record.logical);
      if (!sameSnapshot(current, record.installedSnapshot, { identity: true })) {
        throw resetCollision(`Installed packaged agent changed before completion: ${record.label}.`, {
          path: record.current, expected: record.installedSnapshot, current
        });
      }
      if (record.moved) {
        const staged = await snapshotPath(record.backup, record.logical);
        if (!sameSnapshot(staged, record.backupSnapshot, { identity: true })) {
          throw resetCollision(`Staged packaged-agent bytes changed before cleanup: ${record.label}.`, {
            path: record.current, backup: record.backup, expected: record.backupSnapshot, current: staged
          });
        }
      }
    }
    for (const record of recoveredAgents) {
      const active = await snapshotPath(record.current, record.logical);
      if (active.exists) throw resetCollision(
        `Recovered custom agent reappeared in active discovery before completion: ${record.sourcePath}.`,
        { path: record.current, current: active }
      );
      const retained = await snapshotPath(
        path.join(repository, ...record.recoveryPath.split('/')), record.recoveryPath
      );
      if (!sameSnapshot(retained, record.recoverySnapshot, { identity: true })) {
        throw resetCollision(`Recovered custom-agent bytes changed before completion: ${record.recoveryPath}.`, {
          path: record.recoveryPath, expected: record.recoverySnapshot, current: retained
        });
      }
      if (record.moved) {
        const staged = await snapshotPath(record.backup, record.logical);
        if (!sameSnapshot(staged, record.backupSnapshot, { identity: true })) {
          throw resetCollision(`Staged custom-agent bytes changed before cleanup: ${record.sourcePath}.`, {
            path: record.current, backup: record.backup, expected: record.backupSnapshot, current: staged
          });
        }
      }
    }
    completed = true;
    successResult = {
      ...plan,
      completed: true,
      installedAgents: installedAgents.map((file) => path.posix.join('.github/agents', file)),
      warnings: [
        ...(plan.warnings ?? []),
        ...(plan.customAgentRecoveries ?? []).map((recovery) =>
          `Invalid custom agent ${recovery.sourceDisplay} was preserved byte-for-byte at `
          + `${recovery.recoveryDisplay} (${recovery.sha256}) and removed from active agent discovery: `
          + recovery.reason)
      ],
      next: [
        `Review git diff -- singularity .github/agents ${RECOVERED_AGENTS_ROOT}`,
        'Run singularity-flow init --check',
        'Commit the reset on the current branch when the replacement is correct'
      ]
    };
    return successResult;
  } catch (error) {
    operationError = error;
    // Rollback failures were swallowed and the backup was then deleted regardless, so a restore
    // that did not happen looked exactly like one that did. They are collected instead: if any of
    // them failed, the backup is the only remaining copy and it is kept and named.
    const failures = [];
    const attempt = async (label, action) => {
      try { await action(); } catch (failure) { failures.push(`${label}: ${failure.message}`); }
    };
    for (const record of [...recoveredAgents].reverse()) {
      if (record.targetRecord) {
        await attempt(record.recoveryPath, async () => {
          await refreshRecordParentGuard(record.targetRecord);
          await withdrawOwnedReplacement(record.targetRecord, staging, {
            fault, stage: `rollback:${record.targetRecord.logical}`
          });
        });
      }
      await attempt(record.sourcePath, async () => {
        await refreshRecordParentGuard(record);
        await restoreStagedFile(record, staging, {
          fault, stage: `rollback:${record.logical}`, forceCopy: forceCopyRestore
        });
      });
    }
    // Do not prune recovery directories on a failed reset. A parent such as `.github` can be
    // swapped for a symlink after the last guarded file operation; an unguarded rmdir would then
    // remove an unrelated empty directory outside the repository. Empty, SFlow-named directories
    // are harmless rollback residue, while every byte-bearing path above remains guarded.
    for (const record of [...agentBackups].reverse()) {
      await attempt(record.label, async () => {
        await refreshRecordParentGuard(record);
        await restoreStagedFile(record, staging, {
          fault, stage: `rollback:${record.logical}`, forceCopy: forceCopyRestore
        });
      });
    }
    for (const runtime of [...runtimeBackups].reverse()) {
      await attempt(runtime.label, async () => {
        await refreshRecordParentGuard(runtime);
        await restoreDirectory(runtime, staging, {
          fault, stage: `rollback:${runtime.logical}`
        });
      });
    }
    for (const record of [...controlRecords].reverse()) {
      await attempt(record.label, async () => {
        await refreshRecordParentGuard(record);
        await restoreDirectory(record, staging, {
          fault, stage: `rollback:${record.logical}`
        });
      });
    }
    if (failures.length) {
      restoreFailed = true;
      throw new SingularityFlowError(
        `Factory reset failed and could not be fully undone: ${failures.join('; ')}. `
        + `Your previous configuration is still in ${staging}`
        + `${runtimeBackups.some((item) => item.moved) ? ` and runtime backups are at ${runtimeBackups.filter((item) => item.moved).map((item) => item.backup).join(', ')}` : ''}; `
        + 'move them back by hand before rerunning. '
        + `The original failure was: ${error.message}`,
        {
          code: 'FACTORY_RESET_ROLLBACK_FAILED',
          details: { staging, failures, originalError: error.message }
        }
      );
    }
    throw error;
  } finally {
    // Once the replacement validates, the backup is deliberately destroyed: Git history is the
    // recovery path and a factory reset must not leave a second local state tree behind. The one
    // exception is a rollback that did not fully succeed — then this directory holds the only copy
    // of the user's configuration, and deleting it is the last thing that should happen.
    if (!restoreFailed) {
      let skipStagingCleanup = false;
      const skipRuntimeCleanup = new Set();
      const cleanupWarning = (warning, field, value) => {
        if (completed && successResult) {
          if (field === 'cleanupPendingPaths') {
            successResult[field] = [...(successResult[field] ?? []), value];
          } else successResult[field] = value;
          successResult.warnings = [...(successResult.warnings ?? []), warning];
        } else if (operationError && typeof operationError.message === 'string') {
          operationError.message = `${operationError.message} ${warning}`;
        }
      };

      // Run every injectable cleanup boundary and verify every disposable inode before deleting
      // any of them. A process with an already-open descriptor can still write after the earlier
      // completion checks; those newest bytes are retained and reported as a collision.
      let stagingParentGuard = null;
      try {
        stagingParentGuard = await directoryChainGuard(
          repository, '', 'Factory-reset staging parent'
        );
        if (fault) await fault('before-staging-cleanup');
        await assertDirectoryChainGuard(stagingParentGuard);
      } catch (cleanupError) {
        if (!stagingParentGuard || cleanupError?.code === 'FACTORY_RESET_SCOPE_CHANGED') {
          restoreFailed = true;
          throw retainedResetDataError(cleanupError, staging, runtimeBackups);
        } else {
          skipStagingCleanup = true;
          cleanupWarning(
            `Factory-reset staging cleanup is still pending at ${staging}: ${cleanupError.message}`,
            'cleanupPendingPath', staging
          );
        }
      }
      for (let index = 0; index < runtimeBackups.length; index += 1) {
        const runtime = runtimeBackups[index];
        if (!runtime.moved) continue;
        let runtimeParentGuard = null;
        try {
          runtimeParentGuard = await directoryChainGuard(
            path.dirname(runtime.backup), '', `${runtime.label} cleanup parent`
          );
          if (fault) await fault(`before-runtime-backup-cleanup:${index + 1}`);
          await assertDirectoryChainGuard(runtimeParentGuard);
        } catch (cleanupError) {
          if (!runtimeParentGuard || cleanupError?.code === 'FACTORY_RESET_SCOPE_CHANGED') {
            restoreFailed = true;
            throw retainedResetDataError(cleanupError, staging, runtimeBackups);
          } else {
            skipRuntimeCleanup.add(index);
            cleanupWarning(
              `Factory-reset runtime cleanup is still pending at ${runtime.backup}: ${cleanupError.message}`,
              'cleanupPendingPaths', runtime.backup
            );
          }
        }
      }

      const disposableRecords = [
        ...controlRecords,
        ...agentBackups,
        ...recoveredAgents,
        ...recoveredAgents.map((record) => record.targetRecord).filter(Boolean)
      ];
      try {
        if (!skipStagingCleanup) {
          for (const record of disposableRecords) {
            if (record.moved) {
              const current = await snapshotPath(record.backup, record.logical);
              if (!sameSnapshot(current, record.backupSnapshot, { identity: true })) {
                throw resetCollision(
                  `Factory reset retained staging because discarded bytes changed late: ${record.label}.`,
                  { staging, backup: record.backup, expected: record.backupSnapshot, current }
                );
              }
            }
            if (record.withdrawnReplacement && record.withdrawnSnapshot) {
              const current = await snapshotPath(record.withdrawnReplacement, record.logical);
              if (!sameSnapshot(current, record.withdrawnSnapshot, { identity: true })) {
                throw resetCollision(
                  `Factory reset retained staging because a withdrawn replacement changed late: ${record.label}.`,
                  { staging, backup: record.withdrawnReplacement, expected: record.withdrawnSnapshot, current }
                );
              }
            }
          }
        }
        for (let index = 0; index < runtimeBackups.length; index += 1) {
          const runtime = runtimeBackups[index];
          if (!runtime.moved || skipRuntimeCleanup.has(index)) continue;
          const current = await snapshotPath(runtime.backup, runtime.logical);
          if (!sameSnapshot(current, runtime.backupSnapshot, { identity: true })) {
            throw resetCollision(
              `Factory reset retained runtime backup because its bytes changed late: ${runtime.label}.`,
              { staging, backup: runtime.backup, expected: runtime.backupSnapshot, current }
            );
          }
        }
      } catch (collision) {
        restoreFailed = true;
        throw retainedResetDataError(collision, staging, runtimeBackups);
      }

      // Only after the whole cleanup set passed one freshness barrier may individual paths go.
      // Cleanup locks remain warnings, while a byte/identity collision above is a hard failure.
      for (let index = 0; index < runtimeBackups.length; index += 1) {
        const runtime = runtimeBackups[index];
        if (!runtime.moved || skipRuntimeCleanup.has(index)) continue;
        try { await rm(runtime.backup, { recursive: true, force: true }); }
        catch (cleanupError) {
          cleanupWarning(
            `Factory-reset runtime cleanup is still pending at ${runtime.backup}: ${cleanupError.message}`,
            'cleanupPendingPaths', runtime.backup
          );
        }
      }
      if (!skipStagingCleanup) {
        try { await rm(staging, { recursive: true, force: true }); }
        catch (cleanupError) {
          cleanupWarning(
            `Factory-reset staging cleanup is still pending at ${staging}: ${cleanupError.message}`,
            'cleanupPendingPath', staging
          );
        }
      }
    }
  }
}

export async function factoryResetRepository(root, options = {}) {
  return withRepositoryResetBarrier(root, async () => {
    await assertNoActiveSubjectLocks(root);
    return factoryResetRepositoryLocked(root, options);
  }, {
    fault: options.fault ? (stage) => options.fault(`barrier:${stage}`) : null
  });
}

/**
 * Preview the deliberately broader local reset without treating registered workspace clones as
 * disposable. The registry is local convenience state; the clones contain application source and
 * therefore remain outside the deletion boundary even for RESET ALL.
 */
export async function factoryResetAllPlan(root, {
  packageVersion = null,
  localStateRoot = machineStateRoot()
} = {}) {
  const repository = await factoryResetPlan(root, { packageVersion });
  await directoryState(localStateRoot, 'Singularity machine-local state root');
  return {
    ...repository,
    operation: 'factory-reset-all',
    confirmation: RESET_ALL_CONFIRMATION,
    localStateRoot,
    remove: [
      ...repository.remove,
      `${localStateRoot} (saved workspace registry, active selection, lead-repository registry, and CLI telemetry setup)`
    ],
    preserve: [
      ...repository.preserve.filter((item) => item !== 'the global workspace registry and workspace clones'),
      'physical workspace directories and repository clones; only their local registrations are removed',
      'VS Code SecretStorage credentials; reset Jira or Teams credentials separately in VS Code'
    ]
  };
}

async function stageMachineState(localStateRoot, machineBackup, lockPaths, moved, fault = null) {
  const machineState = await directoryState(localStateRoot, 'Singularity machine-local state root');
  if (!machineState.exists) return moved;
  await mkdir(machineBackup, { recursive: true });
  for (const entry of await readdir(localStateRoot, { withFileTypes: true })) {
    const current = path.join(localStateRoot, entry.name);
    if (lockPaths.has(current)) continue;
    const backup = path.join(machineBackup, entry.name);
    const record = {
      label: `machine-local state ${entry.name}`,
      logical: `machine-state/${entry.name}`,
      current,
      backup,
      before: await snapshotPath(current, `machine-state/${entry.name}`),
      moved: false,
      replacementInstalled: false,
      guardAnchor: localStateRoot,
      guardRelative: ''
    };
    if (!['file', 'directory', 'symlink'].includes(record.before.kind)) {
      throw new SingularityFlowError(
        `Cannot stage unsupported machine-local state ${current}; expected a file, directory, or symbolic link.`
      );
    }
    moved.push(record);
    await refreshRecordParentGuard(record);
    await stageVerifiedMove(record, { fault, stage: `machine-state:${entry.name}` });
  }
  return moved;
}

async function restoreMachineState(moved, fault = null) {
  const failures = [];
  for (const entry of [...moved].reverse()) {
    if (!entry.moved) continue;
    try {
      await refreshRecordParentGuard(entry);
      const stage = `rollback:machine-state:${path.basename(entry.current)}`;
      if (entry.before.kind === 'file') {
        await restoreFileNoReplace(entry.backup, entry.current, entry.logical, {
          fault, stage, parentGuard: entry.parentGuard
        });
        entry.moved = false;
        continue;
      }
      if (entry.before.kind === 'symlink') {
        await restoreSymlinkNoReplace(entry.backup, entry.current, entry.logical, {
          fault, stage, parentGuard: entry.parentGuard
        });
        entry.moved = false;
        continue;
      }
      if (entry.before.kind === 'directory') {
        await restoreDirectory(entry, path.dirname(entry.backup), { fault, stage });
        continue;
      }
      throw new SingularityFlowError(
        `Cannot restore unsupported machine-local state ${entry.current}; backup remains at ${entry.backup}.`
      );
    } catch (error) {
      failures.push(`${entry.current}: ${error.message}`);
    }
  }
  return failures;
}

function appendWarning(target, warning) {
  if (target && typeof target === 'object') {
    target.warnings = [...(target.warnings ?? []), warning];
  }
}

/** Reset repository-owned state and the machine-local registry as one recoverable operation. */
export async function factoryResetAll(root, {
  confirmation,
  packageVersion = null,
  localStateRoot = machineStateRoot(),
  fault = null
} = {}) {
  if (confirmation !== RESET_ALL_CONFIRMATION) {
    throw new SingularityFlowError(
      `Reset all requires --yes (confirmation '${RESET_ALL_CONFIRMATION}'). Run 'sflow reset-all' to preview its exact scope.`
    );
  }

  // Stage the machine state while holding the three leases used by its mutable registries. If the
  // repository reset fails, restore every entry without deleting a pathname another process created
  // in the meantime. A reset must never turn a concurrent registration into rollback collateral.
  const machineParent = path.dirname(localStateRoot);
  await mkdir(machineParent, { recursive: true });
  let result = null;
  let operationError = null;
  try {
    result = await withMachineStateResetBarrier({ localStateRoot }, async ({ lockPaths }) => {
      // Read and validate the machine-state boundary only after the reset barrier and all registry
      // writer leases are held. A registration cannot be added between planning and staging.
      const plan = await factoryResetAllPlan(root, { packageVersion, localStateRoot });
      const staging = await mkdtemp(path.join(machineParent, '.sflow-reset-all-'));
      const stagingParentGuard = await directoryChainGuard(
        machineParent, '', 'Reset-all machine staging parent'
      );
      const machineBackup = path.join(staging, 'machine-state');
      const moved = [];
      let repository;
      try {
        await stageMachineState(localStateRoot, machineBackup, lockPaths, moved,
          fault ? (stage) => fault(stage) : null);
        if (fault) await fault('after-machine-state-move');
        repository = await factoryResetRepository(root, {
          confirmation: (await factoryResetPlan(root, { packageVersion })).confirmation,
          packageVersion,
          allowDirty: true,
          fault: fault ? (stage) => fault(`repository:${stage}`) : null
        });
      } catch (error) {
        const failures = await restoreMachineState(moved, fault);
        if (failures.length) {
          throw new SingularityFlowError(
            `Reset all failed and machine state could not be fully restored: ${failures.join('; ')}. `
            + `The unrestored previous machine state remains in ${machineBackup}. `
            + `The original failure was: ${error.message}`,
            {
              code: 'RESET_ALL_MACHINE_RESTORE_FAILED',
              details: { staging, machineBackup, failures }
            }
          );
        }
        try {
          await assertDirectoryChainGuard(stagingParentGuard);
          await rm(staging, { recursive: true, force: true });
        } catch (cleanupError) {
          const warning = `Reset-all rollback staging cleanup is still pending at ${staging}: ${cleanupError.message}`;
          if (error && typeof error.message === 'string') error.message = `${error.message} ${warning}`;
        }
        throw error;
      }

      // The repository replacement has committed and destroyed its rollback copy. Failure to delete
      // the machine backup now is cleanup residue, not grounds to restore an old registry beside the
      // new repository controls and report a false all-or-nothing failure.
      const completed = {
        ...plan,
        completed: true,
        installedAgents: repository.installedAgents,
        next: repository.next,
        ...(repository.cleanupPendingPath
          ? { cleanupPendingPath: repository.cleanupPendingPath } : {}),
        ...(repository.cleanupPendingPaths
          ? { cleanupPendingPaths: [...repository.cleanupPendingPaths] } : {}),
        ...(repository.barrierPendingPath
          ? { barrierPendingPath: repository.barrierPendingPath } : {}),
        ...(repository.warnings?.length ? { warnings: [...repository.warnings] } : {})
      };
      try {
        if (fault) await fault('before-machine-state-staging-cleanup');
        await assertDirectoryChainGuard(stagingParentGuard);
        for (const entry of moved.filter((candidate) => candidate.moved)) {
          const current = await snapshotPath(entry.backup, entry.logical);
          if (!sameSnapshot(current, entry.backupSnapshot, { identity: true })) {
            throw new SingularityFlowError(
              `Reset all retained machine-state recovery data because ${entry.label} changed late. `
              + `Inspect ${machineBackup} before retrying.`,
              {
                code: 'RESET_ALL_MACHINE_CLEANUP_COLLISION',
                details: {
                  staging, machineBackup, backup: entry.backup,
                  expected: entry.backupSnapshot, current
                }
              }
            );
          }
        }
        await rm(staging, { recursive: true, force: true });
      } catch (cleanupError) {
        if (cleanupError?.code === 'FACTORY_RESET_SCOPE_CHANGED'
            || cleanupError?.code === 'RESET_ALL_MACHINE_CLEANUP_COLLISION') {
          if (cleanupError?.code === 'FACTORY_RESET_SCOPE_CHANGED') {
            throw new SingularityFlowError(
              `${cleanupError.message} Machine-state recovery data was retained at ${machineBackup}.`,
              {
                code: 'RESET_ALL_MACHINE_CLEANUP_COLLISION',
                details: {
                  ...(cleanupError.details ?? {}), staging, machineBackup,
                  originalError: cleanupError.message
                },
                cause: cleanupError
              }
            );
          }
          throw cleanupError;
        }
        completed.machineStateCleanupPendingPath = staging;
        appendWarning(completed,
          `Reset-all machine-state cleanup is still pending at ${staging}: ${cleanupError.message}`);
      }
      return completed;
    });
  } catch (error) {
    operationError = error;
  }

  // Lease release removes the only entries left by reset itself. Remove the directory only when it
  // is still empty; ENOTEMPTY means a post-barrier writer created fresh state, which must survive.
  try { await rmdir(localStateRoot); }
  catch (cleanupError) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(cleanupError?.code)) {
      const warning = `Reset-all empty machine-state directory cleanup is still pending at ${localStateRoot}: ${cleanupError.message}`;
      if (operationError && typeof operationError.message === 'string') {
        operationError.message = `${operationError.message} ${warning}`;
      } else appendWarning(result, warning);
    }
  }
  if (operationError) throw operationError;
  return result;
}
