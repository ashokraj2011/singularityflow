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

function pathContains(parent, candidate, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path;
  const relative = api.relative(api.resolve(String(parent)), api.resolve(String(candidate)));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
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

/** Resolve a deterministic machine-local path without writing into the source repository. */
export async function storyWorktreePath(root, workId) {
  const id = portableId(workId);
  const context = await workspaceMemberContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile(), { strict: true }
  );
  if (context?.workspacePath && context?.repositoryId) {
    return path.join(context.workspacePath, '.singularity-flow', 'story-worktrees', id, 'repos', context.repositoryId);
  }
  const repositoryKey = digest(gitCommonDir(root)).slice(0, 12);
  return path.join(path.dirname(path.resolve(root)), '.singularity-flow', 'story-worktrees', repositoryKey, id);
}

/**
 * Create (or resume) the disposable launch checkout. The temporary branch exists only so Git can
 * register the worktree; the normal Story transaction switches it to the canonical Story branch.
 */
export async function prepareStoryWorktree(root, workId, { base = 'HEAD' } = {}) {
  const id = portableId(workId);
  const target = path.resolve(await storyWorktreePath(root, id));
  const stagingBranch = `sflow-start-${digest(`${gitCommonDir(root)}\0${id}`).slice(0, 16)}`;
  const registered = worktreeInventory(root).find((entry) => samePlatformPath(entry.path, target));
  if (registered) {
    if (![id, stagingBranch].includes(registered.branch)) {
      throw new SingularityFlowError(
        `Managed path ${target} is registered for branch '${registered.branch ?? 'detached HEAD'}', not Story '${id}'.`,
        { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' }
      );
    }
    return {
      schemaVersion: 1, workId: id, sourceRepository: path.resolve(root), repositoryPath: target,
      stagingBranch, created: false, resumed: true, preparedAt: nowIso()
    };
  }
  const stagingExists = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${stagingBranch}`], {
    cwd: root, allowFailure: true
  }).status === 0;
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
    stagingBranch, created: true, resumed: false, preparedAt: nowIso()
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

/**
 * Roll back only an unpublished launch. A durable workflow or remote Story ref is never removed;
 * the recovery path returns its exact worktree path instead.
 */
export function rollbackStoryWorktree(prepared) {
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
  const removed = run('git', ['worktree', 'remove', '--force', '--', prepared.repositoryPath], {
    cwd: root, allowFailure: true
  });
  if (removed.status !== 0 && !/not a working tree|does not exist/i.test(removed.stderr || removed.stdout)) {
    throw new SingularityFlowError(
      `Story start failed and its isolated checkout could not be removed: ${(removed.stderr || removed.stdout).trim()}`,
      { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' }
    );
  }
  for (const branch of [id, prepared.stagingBranch]) {
    run('git', ['branch', '-D', '--', branch], { cwd: root, allowFailure: true });
  }
  return { removed: true, retained: false, repositoryPath: prepared.repositoryPath };
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
    throw new SingularityFlowError(
      `${originalError.message}\nThe governed Story state was retained at ${recovery.repositoryPath}; open that folder and run singularity-flow doctor.`,
      {
        code: originalError.code ?? 'STORY_WORKTREE_RECOVERY_REQUIRED',
        details: { repositoryPath: recovery.repositoryPath },
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
