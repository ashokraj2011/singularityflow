/** Machine-local, independent branch checkouts. These never replace manifest-owned repositories. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isGitRefName, isPortableRepositoryPathComponent, SingularityFlowError } from './util.mjs';
import { readRecord } from './schema-migrations.mjs';

export const BRANCH_CHECKOUT_RECORD = 'singularity-flow/branch-checkout.json';

export function workspaceBranchFolder(branch) {
  if (typeof branch !== 'string' || branch.startsWith('-') || !isGitRefName(`refs/heads/${branch}`)) {
    throw new SingularityFlowError('Choose one valid, explicit application branch.', { code: 'STORY_BASE_INVALID' });
  }
  const label = branch.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'branch';
  return `${label}--${createHash('sha256').update(branch).digest('hex').slice(0, 12)}`;
}

export function workspaceBranchPath(workspacePath, repositoryId, branch, retry = '') {
  if (!isPortableRepositoryPathComponent(repositoryId)) throw new SingularityFlowError('Invalid repository ID.');
  if (retry && !/^--retry-[a-f0-9]{16}$/u.test(retry)) throw new SingularityFlowError('Invalid branch checkout attempt.');
  return path.join(workspacePath, 'repos', `${workspaceBranchFolder(branch)}${retry}`, repositoryId);
}

export function workspaceBranchPointer(workspacePath, repositoryId, branch) {
  if (!isPortableRepositoryPathComponent(repositoryId)) throw new SingularityFlowError('Invalid repository ID.');
  return path.join(workspacePath, '.singularity-flow', 'branch-checkouts', workspaceBranchFolder(branch), `${repositoryId}.json`);
}

export async function readBranchRecord(file, family = 'workspace-branch-checkout') {
  const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) return null;
  try { return readRecord(family, await readFile(file)).record; } catch { return null; }
}

/** The receipt selects a location only; callers still verify Git identity and lifecycle authority. */
export async function workspaceBranchMember(commonDir, workspace) {
  const record = await readBranchRecord(path.join(commonDir, BRANCH_CHECKOUT_RECORD));
  if (!record || record.workspaceId !== workspace.id
      || !/^[a-f0-9]{40,64}$/u.test(record.baseCommit ?? '')) return null;
  const repository = Object.hasOwn(workspace.repositories, record.repositoryId) ? workspace.repositories[record.repositoryId] : null;
  if (!repository || repository.url !== record.repositoryUrl || repository.path !== record.originalRepositoryPath) return null;
  let expected;
  try { expected = workspaceBranchPath(workspace.path, record.repositoryId, record.branch, record.retry ?? ''); }
  catch { return null; }
  const workspacePath = await realpath(workspace.path).catch(() => null);
  if (!workspacePath || workspacePath !== record.workspacePath) return null;
  // A receipt cannot turn a symlinked repos/branch directory into a workspace member.
  let parent = workspacePath;
  for (const part of path.relative(workspace.path, expected).split(path.sep)) {
    parent = path.join(parent, part);
    const info = await lstat(parent).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
  }
  const actual = await realpath(commonDir).catch(() => null);
  const git = await lstat(path.join(expected, '.git')).catch(() => null);
  if (!git?.isDirectory() || git.isSymbolicLink() || actual !== path.join(await realpath(expected).catch(() => ''), '.git')) return null;
  const objects = await lstat(path.join(actual, 'objects')).catch(() => null);
  if (!objects?.isDirectory() || objects.isSymbolicLink()
      || await lstat(path.join(actual, 'objects/info/alternates')).catch(() => null)) return null;
  return { repositoryId: record.repositoryId, repository, repositoryPath: path.dirname(actual), record };
}

export async function preparedWorkspaceBranch(workspace, repositoryId, branch) {
  const pointer = await readBranchRecord(workspaceBranchPointer(workspace.path, repositoryId, branch), 'workspace-branch-pointer');
  if (!pointer || typeof pointer.retry !== 'string') return null;
  let target;
  try { target = workspaceBranchPath(workspace.path, repositoryId, branch, pointer.retry); } catch { return null; }
  const member = await workspaceBranchMember(path.join(target, '.git'), workspace);
  return member?.record.branch === branch && member.repositoryId === repositoryId ? member : null;
}
