/** Download a branch into an independent repository, without reading or repairing the old objects. */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { withRegistryFileLease } from './file-lease.mjs';
import { GitRemoteSession, requireRemoteObservation, runRemoteGitAsync } from './git-execution.mjs';
import { frozenRemoteTransport } from './git-remote-diagnostics.mjs';
import { processResultSucceeded } from './process-result.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { measureCommandSpan } from './dx-timing-context.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';
import { workspaceRepositoryPath } from './workspace-manifest.mjs';
import {
  BRANCH_CHECKOUT_RECORD, preparedWorkspaceBranch, workspaceBranchFolder, workspaceBranchPath,
  workspaceBranchPointer
} from './workspace-branch-locations.mjs';

async function safeParents(workspacePath, target) {
  const relative = path.relative(workspacePath, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new SingularityFlowError('Unsafe branch checkout path.');
  let current = workspacePath;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SingularityFlowError(
      `Branch download parent is not an owned directory: ${current}`, { code: 'WORKSPACE_BRANCH_PATH_UNSAFE' });
  }
}

export async function prepareWorkspaceBranch(workspace, repositoryId, branch, {
  signal = null, env = process.env, runGit = runRemoteGitAsync, reuse = false
} = {}) {
  workspaceBranchFolder(branch);
  const repository = Object.hasOwn(workspace.repositories, repositoryId) ? workspace.repositories[repositoryId] : null;
  if (!repository) throw new SingularityFlowError(`Repository '${repositoryId}' is not in this workspace.`);
  const workspacePath = await realpath(workspace.path);
  const original = workspaceRepositoryPath(workspace, repository);
  const pointer = workspaceBranchPointer(workspacePath, repositoryId, branch);
  await safeParents(workspacePath, path.dirname(pointer));
  return withRegistryFileLease(pointer, async () => {
    if (signal?.aborted) throw new SingularityFlowError('Branch download was cancelled.');
    const existing = reuse ? await preparedWorkspaceBranch({ ...workspace, path: workspacePath }, repositoryId, branch) : null;
    if (existing) return { status: 'ready', reused: true, repositoryPath: existing.repositoryPath,
      repositoryId, branch, baseCommit: existing.record.baseCommit, originalRepositoryPath: original, originalPreserved: true };
    // This is an explicit fresh-download action, not a fetch in the previous objects: even an
    // earlier successful checkout might have been offloaded since. Preserve every prior attempt.
    let retry = '';
    let target = workspaceBranchPath(workspacePath, repositoryId, branch);
    await safeParents(workspacePath, path.dirname(target));
    try { await mkdir(target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      retry = `--retry-${randomBytes(8).toString('hex')}`;
      target = workspaceBranchPath(workspacePath, repositoryId, branch, retry);
      await safeParents(workspacePath, path.dirname(target));
      await mkdir(target);
    }
    const owner = await lstat(target);
    const transport = frozenRemoteTransport(repository.url, { env });
    const invoke = async (args, cwd = workspacePath) => {
      const result = await runGit(args, { cwd, operation: 'remote-configuration', timeoutMs: 5 * 60_000,
        env: transport.env, signal, allowFailure: true });
      if (!processResultSucceeded(result)) throw new SingularityFlowError(
        `Fresh branch download did not complete. ${result.failure?.advice ?? 'Inspect Git access and retry.'} `
        + 'The original repository and any partial download were preserved.', {
          code: result.failure?.code ?? 'WORKSPACE_BRANCH_DOWNLOAD_FAILED',
          details: { partialRepositoryPath: target, originalRepositoryPath: original }
        });
      return result;
    };
    const observed = requireRemoteObservation(await new GitRemoteSession({ cwd: workspacePath,
      env, runAsyncCommand: runGit }).observeAsync(repository.url, {
      includeHead: false, refs: [`refs/heads/${branch}`], signal, timeoutMs: 5 * 60_000
    }), `selected branch '${branch}'`);
    const commit = observed.refs.get(`refs/heads/${branch}`);
    if (!commit) throw new SingularityFlowError(`Selected branch '${branch}' is not published.`, { code: 'STORY_BASE_INVALID' });
    // --no-local also prevents hardlink/alternate borrowing for local-path remotes in tests or offices.
    await measureCommandSpan('start.branch-download', () => invoke(['clone', '--no-local', '--no-tags', '--single-branch', '--no-checkout',
      '--no-recurse-submodules', '--branch', branch, '--', transport.remote, target]));
    await invoke(['remote', 'set-url', 'origin', repository.url], target);
    const tip = (await invoke(['rev-parse', `refs/remotes/origin/${branch}^{commit}`], target)).stdout.trim();
    if (tip !== commit) throw new SingularityFlowError(
      'The selected branch moved during the download. The download and original repository are preserved; retry for its new revision.',
      { code: 'STORY_BASE_INVALID' });
    await invoke(['checkout', branch], target);
    if ((await invoke(['rev-parse', 'HEAD'], target)).stdout.trim() !== commit) {
      throw new SingularityFlowError('The fresh checkout no longer matches the downloaded revision. It was preserved, not selected.',
        { code: 'STORY_BASE_INVALID' });
    }
    await invoke(['cat-file', '-e', `${commit}^{tree}`], target);
    const after = await lstat(target);
    if (after.dev !== owner.dev || after.ino !== owner.ino || after.isSymbolicLink()) {
      throw new SingularityFlowError('The download directory changed; no checkout was registered.', { code: 'WORKSPACE_BRANCH_PATH_UNSAFE' });
    }
    const record = { schemaVersion: currentSchemaVersion('workspace-branch-checkout'), workspaceId: workspace.id, workspacePath, repositoryId,
      originalRepositoryPath: repository.path, repositoryUrl: repository.url, branch, retry,
      baseCommit: commit, createdAt: new Date().toISOString() };
    await writeAtomic(path.join(target, '.git', BRANCH_CHECKOUT_RECORD), JSON.stringify(record), { mode: 0o600 });
    // A successful independent-object proof is required before the pointer can be used by intake.
    const { workspaceBranchMember } = await import('./workspace-branch-locations.mjs');
    if (!await workspaceBranchMember(path.join(target, '.git'), { ...workspace, path: workspacePath })) {
      throw new SingularityFlowError('The fresh checkout could not prove independent local object storage. Nothing was selected.');
    }
    await writeAtomic(pointer, JSON.stringify({ schemaVersion: currentSchemaVersion('workspace-branch-pointer'), retry }), { mode: 0o600 });
    return { status: 'ready', reused: false, repositoryPath: target, repositoryId, branch,
      baseCommit: commit, originalRepositoryPath: original, originalPreserved: true };
  }, { timeoutMs: 5 * 60_000 });
}
