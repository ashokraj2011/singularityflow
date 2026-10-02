/**
 * Managed, per-Story Git worktrees.
 *
 * A Story is independent governed work, but a normal Git checkout can expose only one branch and
 * one index at a time. Starting the next Story in that same checkout therefore made unrelated,
 * uncommitted files from the previous Story a global lock. This module supplies the missing
 * physical isolation boundary: the existing checkout is a read-only launch point and the Story
 * transaction runs in a dedicated linked worktree.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';

import { gitCommonDir, refExists, remoteNames } from './git.mjs';
import { executeGitQuery } from './git-query.mjs';
import { parsePorcelainV2Status } from './git-status-detail.mjs';
import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from './workspace-context.mjs';
import { nowIso, run, SingularityFlowError } from './util.mjs';
import { validatePortableWorkId } from './work-id.mjs';
import {
  DEFAULT_WORK_ITEM_ROOT, workItemRootFromDefinitionText, workItemWorkflowRelative
} from './work-item-location.mjs';

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function portableId(value) {
  const id = validatePortableWorkId(value, {
    label: 'Story worktree ID', code: 'STORY_WORKTREE_INVALID'
  });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new SingularityFlowError(`'${id}' is not a portable Story worktree identifier.`, {
      code: 'STORY_WORKTREE_INVALID'
    });
  }
  return id;
}

/**
 * Compare filesystem path spellings using the host platform's identity rules.
 *
 * Git for Windows may report drive-letter and component casing differently from Node even when
 * both names identify the same directory. Worktree ownership is a security boundary, so callers
 * must not use raw string equality for this comparison.
 */
export function samePlatformPath(left, right, platform = process.platform) {
  if (left == null || right == null) return false;
  const api = platform === 'win32' ? path.win32 : path;
  const normalize = (value) => {
    const resolved = api.resolve(String(value));
    return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

async function sameRegisteredPath(left, right) {
  if (samePlatformPath(left, right)) return true;
  const canonicalRight = await realpath(right).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!canonicalRight) return false;
  // Git may retain an unrelated worktree whose directory is inaccessible or already gone. Its
  // failed realpath cannot prove a match, so skip it; a matching occupied target still fails closed
  // at safeNewPath rather than being adopted through an unverifiable alias.
  const canonicalLeft = await realpath(left).catch(() => null);
  return canonicalLeft != null && samePlatformPath(canonicalLeft, canonicalRight);
}

function pathContains(parent, candidate, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path;
  const relative = api.relative(api.resolve(String(parent)), api.resolve(String(candidate)));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

function legacyStoryPath(parent, candidate, id, repositoryId = null) {
  if (!pathContains(parent, candidate)) return false;
  const parts = path.relative(parent, candidate).split(path.sep);
  const equal = (left, right) => process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
  return repositoryId
    ? parts.length === 3 && equal(parts[0], id) && equal(parts[1], 'repos')
      && equal(parts[2], repositoryId)
    : parts.length === 2 && /^[0-9a-f]{12}$/i.test(parts[0]) && equal(parts[1], id);
}

function worktreeInventory(root) {
  const output = run('git', ['worktree', 'list', '--porcelain'], { cwd: root }).stdout;
  const records = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: path.resolve(line.slice('worktree '.length)), head: null, branch: null };
      records.push(current);
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (current && line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
  }
  return records;
}

async function safeNewPath(root, candidate) {
  const absolute = path.resolve(candidate);
  if (samePlatformPath(absolute, path.parse(absolute).root)
      || samePlatformPath(absolute, root)) {
    throw new SingularityFlowError(`Unsafe Story worktree target: ${absolute}`, {
      code: 'STORY_WORKTREE_CREATION_FAILED'
    });
  }
  if (await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
    throw new SingularityFlowError(
      `Managed Story worktree path already exists but is not registered with Git: ${absolute}.`,
      { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' }
    );
  }
  let ancestor = path.dirname(absolute);
  while (!(await lstat(ancestor).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error)))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const info = await lstat(ancestor);
  if (info.isSymbolicLink()) {
    throw new SingularityFlowError(`Story worktree parent cannot be a symbolic link: ${ancestor}`, {
      code: 'STORY_WORKTREE_CREATION_FAILED'
    });
  }
  await realpath(ancestor);
  await mkdir(path.dirname(absolute), { recursive: true });
  return absolute;
}

/**
 * Keep new worktrees shallow enough for their own governed and reference-repository trees on
 * Windows. The digest is scoped to the owning repository and Story, not to mutable display names.
 * Legacy paths remain recognized by prepareStoryWorktree so an upgrade never abandons a
 * registered checkout or creates a second checkout for the same branch.
 */
async function storyWorktreeLocations(root, id) {
  const common = gitCommonDir(root);
  const canonicalCommon = await realpath(common);
  const context = await workspaceMemberContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile(), { strict: true }
  );
  if (context?.workspacePath && context?.repositoryId) {
    const parent = path.join(context.workspacePath, '.singularity-flow', 'story-worktrees');
    return {
      compact: path.join(parent, `.w-${digest(`${canonicalCommon}\0${context.repositoryId}\0${id}`).slice(0, 24)}`),
      legacy: path.join(parent, id, 'repos', context.repositoryId),
      legacyRepositoryId: context.repositoryId
    };
  }
  const parent = path.join(path.dirname(path.resolve(root)), '.singularity-flow', 'story-worktrees');
  return {
    compact: path.join(parent, `.w-${digest(`${canonicalCommon}\0${id}`).slice(0, 24)}`),
    legacy: path.join(parent, digest(common).slice(0, 12), id),
    legacyRepositoryId: null
  };
}

/** Resolve a deterministic machine-local path without writing into the source repository. */
export async function storyWorktreePath(root, workId) {
  return (await storyWorktreeLocations(root, portableId(workId))).compact;
}

/**
 * Locate an already prepared launch checkout without creating, switching or cleaning anything.
 * A completed Story branch is deliberately not a prepared pre-feature baseline checkout.
 */
export async function preparedStoryWorktreePath(root, workId, { baseCommit = null } = {}) {
  const id = portableId(workId);
  if (baseCommit !== null && !/^[a-f0-9]{40,64}$/u.test(baseCommit)) {
    throw new SingularityFlowError('Prepared Story lookup requires an exact base commit.', { code: 'STORY_WORKTREE_INVALID' });
  }
  const locations = await storyWorktreeLocations(root, id);
  const common = executeGitQuery(root, 'repository.paths').commonDir;
  const canonicalCommon = await realpath(common);
  const stagingBranches = new Set([common, canonicalCommon].map(value => `sflow-start-${digest(`${value}\0${id}`).slice(0, 16)}`));
  const inventory = worktreeInventory(root);
  const candidates = [];
  const managedParent = await realpath(path.dirname(locations.compact)).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  const canonicalRoot = await realpath(root);
  for (const entry of inventory) {
    const exact = await sameRegisteredPath(entry.path, locations.compact)
      || await sameRegisteredPath(entry.path, locations.legacy);
    const canonicalEntry = await realpath(entry.path).catch(() => null);
    const legacy = Boolean(canonicalEntry && managedParent
      && legacyStoryPath(managedParent, canonicalEntry, id, locations.legacyRepositoryId));
    // A caller already inside this exact managed launch may inspect itself. This adds no
    // adoption of arbitrary worktrees: the namespace, deterministic basename and staging ref
    // must still bind the same canonical Git common directory and Story ID below.
    const ownCompact = canonicalEntry && samePlatformPath(canonicalEntry, canonicalRoot)
      && path.basename(canonicalEntry) === path.basename(locations.compact)
      && path.basename(path.dirname(canonicalEntry)) === 'story-worktrees'
      && path.basename(path.dirname(path.dirname(canonicalEntry))) === '.singularity-flow';
    if (exact || legacy || ownCompact) candidates.push(entry);
  }
  const refuse = message => { throw new SingularityFlowError(message, { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' }); };
  if (candidates.length > 1) refuse(`Story '${id}' has multiple managed launch checkouts; resolve the exact owner before reviewing baseline evidence.`);
  if (!candidates.length) {
    for (const candidate of [locations.compact, locations.legacy]) {
      if (await lstat(candidate).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
        refuse(`Managed Story path exists without matching Git registration: ${candidate}.`);
      }
    }
    return null;
  }
  const registered = candidates[0];
  try {
    const info = await lstat(registered.path);
    if (!info.isDirectory() || info.isSymbolicLink()) refuse('The prepared Story path is not an ordinary registered worktree directory.');
    const registeredCommon = executeGitQuery(registered.path, 'repository.paths').commonDir;
    if (!samePlatformPath(await realpath(registeredCommon), canonicalCommon)) refuse('The prepared Story checkout belongs to a different Git common directory.');
    stagingBranches.add(`sflow-start-${digest(`${registeredCommon}\0${id}`).slice(0, 16)}`);
    const actualBranch = executeGitQuery(registered.path, 'repository.branch');
    if (!stagingBranches.has(actualBranch) || actualBranch !== registered.branch) {
      refuse(`Managed checkout is not on the exact prepared staging branch for Story '${id}'.`);
    }
    const actualHead = executeGitQuery(registered.path, 'repository.head');
    if (actualHead !== registered.head || baseCommit !== null && actualHead !== baseCommit) {
      refuse(`Prepared Story '${id}' no longer points at the exact requested pre-feature base.`);
    }
    return registered.path;
  } catch (error) {
    if (error.code === 'STORY_WORKTREE_RECOVERY_REQUIRED') throw error;
    throw new SingularityFlowError(`Prepared Story '${id}' could not be verified without changing it.`, {
      code: 'STORY_WORKTREE_RECOVERY_REQUIRED', cause: error
    });
  }
}

/**
 * Create (or resume) the disposable launch checkout. The temporary branch exists only so Git can
 * register the worktree; the normal Story transaction switches it to the canonical Story branch.
 */
export async function prepareStoryWorktree(root, workId, { base = 'HEAD' } = {}) {
  const id = portableId(workId);
  const locations = await storyWorktreeLocations(root, id);
  const target = path.resolve(locations.compact);
  const legacy = path.resolve(locations.legacy);
  const common = gitCommonDir(root);
  const canonicalCommon = await realpath(common);
  const stagingBranch = `sflow-start-${digest(`${canonicalCommon}\0${id}`).slice(0, 16)}`;
  const legacyStagingBranch = `sflow-start-${digest(`${common}\0${id}`).slice(0, 16)}`;
  const stagingBranches = [...new Set([stagingBranch, legacyStagingBranch])];
  const olderStagingName = /^sflow-start-[0-9a-f]{16}$/;
  const inventory = worktreeInventory(root);
  let registered = null;
  let registeredWasLegacy = false;
  for (const entry of inventory) {
    const atCompact = await sameRegisteredPath(entry.path, target);
    const atLegacy = !atCompact && await sameRegisteredPath(entry.path, legacy);
    if (atCompact || atLegacy) {
      registered = entry;
      registeredWasLegacy = atLegacy;
      break;
    }
  }
  if (!registered) {
    // A legacy checkout may have been registered through a different spelling of the same parent
    // (for example /var and /private/var on macOS). Reuse only a worktree registered for this
    // Story within the same managed namespace; never adopt an arbitrary user worktree.
    const managedParent = await realpath(path.dirname(target)).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (managedParent) {
      for (const entry of inventory) {
        if (entry.branch !== id && !olderStagingName.test(entry.branch ?? '')) continue;
        // An unrelated registered checkout can be stale or inaccessible. That is not evidence
        // that it owns this Story's legacy path; the target itself is still checked below.
        const existing = await realpath(entry.path).catch(() => null);
        if (existing && legacyStoryPath(
          managedParent, existing, id, locations.legacyRepositoryId
        )) {
          registered = entry;
          registeredWasLegacy = true;
          break;
        }
      }
    }
  }
  if (registered) {
    let provenOlderStage = false;
    if (registeredWasLegacy && olderStagingName.test(registered.branch ?? '')) {
      try {
        const registeredCommon = gitCommonDir(registered.path);
        provenOlderStage = samePlatformPath(await realpath(registeredCommon), canonicalCommon)
          && registered.branch === `sflow-start-${digest(`${registeredCommon}\0${id}`).slice(0, 16)}`;
      } catch { /* An unverifiable old staging branch is never adopted. */ }
    }
    if (![id, ...stagingBranches].includes(registered.branch) && !provenOlderStage) {
      throw new SingularityFlowError(
        `Managed path ${registered.path} is registered for branch '${registered.branch ?? 'detached HEAD'}', not Story '${id}'.`,
        { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' }
      );
    }
    return {
      schemaVersion: 1, workId: id, sourceRepository: path.resolve(root), repositoryPath: registered.path,
      stagingBranch: stagingBranches.includes(registered.branch) || provenOlderStage
        ? registered.branch : stagingBranch,
      created: false, resumed: true, initialHead: registered.head, preparedAt: nowIso()
    };
  }
  const stagingExists = stagingBranches.some((candidate) => run('git', [
    'show-ref', '--verify', '--quiet', `refs/heads/${candidate}`
  ], { cwd: root, allowFailure: true }).status === 0);
  if (stagingExists) {
    throw new SingularityFlowError(
      `Story '${id}' has an incomplete launch branch but no registered worktree. Run 'git worktree repair', then retry.`,
      { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' }
    );
  }
  await safeNewPath(root, target);
  const added = run('git', ['worktree', 'add', '-b', stagingBranch, '--', target, base], {
    cwd: root, allowFailure: true
  });
  if (added.status !== 0) {
    throw new SingularityFlowError(
      `Git could not create the isolated Story checkout: ${(added.stderr || added.stdout).trim()}`,
      { code: 'STORY_WORKTREE_CREATION_FAILED' }
    );
  }
  return {
    schemaVersion: 1, workId: id, sourceRepository: path.resolve(root), repositoryPath: target,
    stagingBranch, created: true, resumed: false,
    initialHead: run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: target }).stdout.trim(),
    preparedAt: nowIso()
  };
}

/** Remove the temporary launch ref after the worktree has switched to the durable Story branch. */
export function completeStoryWorktree(prepared) {
  const removed = run('git', ['branch', '-D', '--', prepared.stagingBranch], {
    cwd: prepared.sourceRepository, allowFailure: true
  });
  if (removed.status !== 0 && !/not found|not exist/i.test(removed.stderr || removed.stdout)) {
    return {
      ...prepared,
      completedAt: nowIso(),
      cleanupPending: (removed.stderr || removed.stdout).trim() || 'temporary branch removal failed'
    };
  }
  return { ...prepared, completedAt: nowIso(), cleanupPending: null };
}

function durableStoryWorkflowOnBranch(root, id) {
  const definition = run('git', ['show', `${id}:singularity/workflow.yml`], {
    cwd: root, allowFailure: true
  });
  let workItemRoot = DEFAULT_WORK_ITEM_ROOT;
  if (definition.status === 0) {
    try {
      workItemRoot = workItemRootFromDefinitionText(definition.stdout);
    } catch {
      // A branch carrying unreadable governance may still carry the only durable Story commit.
      // Recovery must retain uncertain data; doctor can diagnose it without destroying the branch.
      return true;
    }
  }
  return run('git', [
    'cat-file', '-e', `${id}:${workItemWorkflowRelative(id, workItemRoot)}`
  ], { cwd: root, allowFailure: true }).status === 0;
}

/** Inspect every visible worktree change, including ignored files, before rollback. */
export function storyWorktreeChanges(repositoryPath) {
  const head = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repositoryPath }).stdout.trim();
  const objectFormat = head.length === 40 ? 'sha1' : head.length === 64 ? 'sha256' : null;
  if (!objectFormat) {
    throw new SingularityFlowError('Story worktree commit format could not be verified for recovery.', {
      code: 'STORY_WORKTREE_RECOVERY_REQUIRED'
    });
  }
  const status = run('git', [
    'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching',
    '--ignore-submodules=none'
  ], { cwd: repositoryPath, encoding: 'buffer' });
  let parsed;
  try {
    parsed = parsePorcelainV2Status(status.stdout, {
      objectFormat, untracked: 'all', includeIgnored: true
    });
  } catch (error) {
    throw new SingularityFlowError(`Story worktree changes could not be verified: ${error.message}`, {
      code: 'STORY_WORKTREE_RECOVERY_REQUIRED', cause: error
    });
  }
  return {
    clean: parsed.entries.length === 0,
    changedPaths: [...new Set(parsed.entries.flatMap((entry) => [
      entry.path.display, entry.sourcePath?.display
    ]).filter(Boolean))].sort(),
    entries: parsed.entries.map((entry) => ({
      status: entry.type, path: entry.path, sourcePath: entry.sourcePath ?? null
    }))
  };
}

/**
 * Roll back only an unpublished launch. A durable workflow or remote Story ref is never removed;
 * the recovery path returns its exact worktree path instead.
 */
export function rollbackStoryWorktree(prepared, {
  removeWorktree = (root, repositoryPath) => run('git', [
    'worktree', 'remove', '--', repositoryPath
  ], { cwd: root, allowFailure: true }),
  waitForRetry = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
} = {}) {
  const root = prepared.sourceRepository;
  const id = prepared.workId;
  const workflowAtBranch = durableStoryWorkflowOnBranch(root, id);
  const published = remoteNames(root).some((remote) => (
    refExists(root, `refs/remotes/${remote}/${id}`)
  ));
  if (workflowAtBranch || published) {
    return { removed: false, retained: true, repositoryPath: prepared.repositoryPath };
  }
  // Windows refuses to remove a directory that owns the current process working directory. Unix
  // may appear to allow it, but leaves the process inside an unlinked directory and makes later
  // path resolution unpredictable. Keep the invariant platform-independent so every test host
  // exercises the same ordering requirement as an office Windows laptop.
  if (pathContains(prepared.repositoryPath, process.cwd())) {
    throw new SingularityFlowError(
      `Story worktree cleanup cannot run while the current process is inside ${prepared.repositoryPath}.`,
      {
        code: 'STORY_WORKTREE_RECOVERY_REQUIRED',
        details: { repositoryPath: prepared.repositoryPath }
      }
    );
  }
  const changes = storyWorktreeChanges(prepared.repositoryPath);
  if (!changes.clean) {
    return {
      removed: false, retained: true, repositoryPath: prepared.repositoryPath,
      reason: 'worktree-changes', changedPaths: changes.changedPaths,
      changedEntries: changes.entries
    };
  }
  // Git performs its own final dirty check, closing the gap between our read and removal.
  let removed = removeWorktree(root, prepared.repositoryPath);
  const removalError = () => removed.stderr || removed.stdout || '';
  // Windows file-indexers and virus scanners can briefly hold a newly created checkout open.
  // Retry only a recognizable lock/permission failure, once, after checking that the exact
  // checkout still exists and remains clean. Never force-remove a worktree or discard changes.
  if (removed.status !== 0 && /\b(?:EBUSY|EPERM|EACCES|resource busy|permission denied|access is denied|file in use)\b/iu.test(removalError())) {
    const stillClean = storyWorktreeChanges(prepared.repositoryPath);
    if (!stillClean.clean) return {
      removed: false, retained: true, repositoryPath: prepared.repositoryPath,
      reason: 'worktree-changes', changedPaths: stillClean.changedPaths,
      changedEntries: stillClean.entries
    };
    waitForRetry();
    removed = removeWorktree(root, prepared.repositoryPath);
  }
  if (removed.status !== 0 && !/not a working tree|does not exist/i.test(removed.stderr || removed.stdout)) {
    throw new SingularityFlowError(
      `Story start failed and its isolated checkout could not be removed: ${(removed.stderr || removed.stdout).trim()}`,
      { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' }
    );
  }
  const cleanupPending = [];
  for (const branch of new Set([id, prepared.stagingBranch].filter(Boolean))) {
    const branchRef = `refs/heads/${branch}`;
    const branchHead = run('git', ['rev-parse', '--verify', branchRef], {
      cwd: root, allowFailure: true
    }).stdout.trim();
    // A branch created for this launch and still at its initial commit contains no new Story
    // commit. Delete that exact ref even when the source checkout has switched elsewhere.
    const unchangedNewBranch = prepared.created === true && branchHead
      && branchHead === prepared.initialHead;
    const deleted = unchangedNewBranch
      ? run('git', ['update-ref', '-d', branchRef, branchHead], { cwd: root, allowFailure: true })
      // A pre-existing branch or changed ref needs Git's merged-commit protection.
      : run('git', ['branch', '-d', '--', branch], { cwd: root, allowFailure: true });
    if (deleted.status !== 0 && run('git', [
      'show-ref', '--verify', '--quiet', branchRef
    ], { cwd: root, allowFailure: true }).status === 0) cleanupPending.push(branch);
  }
  return {
    removed: true, retained: false, repositoryPath: prepared.repositoryPath,
    cleanupPending
  };
}

function failureRecord(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    message: error?.message ?? String(error),
    details: error?.details ?? null
  };
}

/**
 * Finish a failed isolated Story start without hiding the failure that initiated recovery.
 *
 * The process must leave the managed checkout before asking Git to remove it. When leaving or
 * removing the checkout also fails, retain both errors in the public recovery result: the first
 * explains why Story start stopped and the second explains why manual cleanup is now required.
 */
export function rollbackFailedStoryWorktree(
  prepared, originalError, previousDirectory, {
    changeDirectory = (directory) => process.chdir(directory),
    rollback = rollbackStoryWorktree
  } = {}
) {
  let recovery;
  let cleanupStage = 'leave-worktree';
  try {
    changeDirectory(previousDirectory);
    cleanupStage = 'remove-worktree';
    recovery = rollback(prepared);
  } catch (cleanupError) {
    const original = failureRecord(originalError);
    const cleanup = failureRecord(cleanupError);
    const action = cleanupStage === 'leave-worktree'
      ? 'leave its isolated checkout before cleanup'
      : 'remove its isolated checkout';
    throw new SingularityFlowError(
      `${original.message}\nStory worktree cleanup also failed while trying to ${action}: ${cleanup.message}\n`
      + `The isolated checkout was retained at ${prepared.repositoryPath}; open that folder and run singularity-flow doctor.`,
      {
        code: 'STORY_WORKTREE_RECOVERY_REQUIRED',
        details: {
          repositoryPath: prepared.repositoryPath,
          cleanupStage,
          originalError: original,
          cleanupError: cleanup
        },
        cause: originalError
      }
    );
  }
  if (recovery.retained) {
    const dirty = recovery.reason === 'worktree-changes';
    const changedPaths = dirty ? recovery.changedPaths : [];
    throw new SingularityFlowError(
      `${originalError.message}\n${dirty
        ? `The isolated checkout contains ${changedPaths.length} changed path(s) and was retained at ${recovery.repositoryPath}. Review git status there, preserve those changes, and retry Story start.`
        : `The governed Story state was retained at ${recovery.repositoryPath}; open that folder and run singularity-flow doctor.`}`,
      {
        code: originalError.code ?? 'STORY_WORKTREE_RECOVERY_REQUIRED',
        details: { repositoryPath: recovery.repositoryPath, ...(dirty ? {
          reason: recovery.reason, changedPaths, changedEntries: recovery.changedEntries
        } : {}) },
        cause: originalError
      }
    );
  }
  if (recovery.cleanupPending?.length) {
    throw new SingularityFlowError(
      `${originalError.message}\nThe isolated checkout was removed, but its branch ${recovery.cleanupPending.join(', ')} contains commits Git would not discard. Review the retained branch before retrying Story start.`,
      {
        code: 'STORY_WORKTREE_RECOVERY_REQUIRED',
        details: { repositoryPath: recovery.repositoryPath, retainedBranches: recovery.cleanupPending },
        cause: originalError
      }
    );
  }
  throw originalError;
}

/** Read-only management surface used by diagnostics and future UI recovery. */
export function listStoryWorktrees(root) {
  return worktreeInventory(root)
    .filter((entry) => entry.path.split(path.sep).includes('story-worktrees'))
    .map((entry) => ({ repositoryPath: entry.path, branch: entry.branch, head: entry.head }));
}

/**
 * Find the existing managed checkout that owns a durable Story branch.
 *
 * Git permits a local branch to be checked out in only one worktree. Session attachment must
 * therefore enter that checkout rather than asking the launch clone to switch to the same branch.
 * Restricting the lookup to Singularity Flow's managed Story paths avoids adopting an unrelated
 * worktree that the contributor created and owns themselves.
 */
export function storyWorktreeForBranch(root, branchName) {
  const requested = String(branchName ?? '').trim();
  if (!requested) return null;
  return listStoryWorktrees(root).find((entry) => entry.branch === requested) ?? null;
}
