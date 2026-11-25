/** Browser navigation over the existing machine-local Story selection. */
import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A shell can launch from a repository subdirectory. Resolve its checkout without running Git. */
export async function launcherCheckout(folder) {
  for (let candidate = folder; ; candidate = path.dirname(candidate)) {
    const git = await lstat(path.join(candidate, '.git')).catch(() => null);
    if (git?.isDirectory() || git?.isFile()) return candidate;
    if (candidate === path.dirname(candidate)) return folder;
  }
}

export async function isEngineCheckout(root, engineRoot) {
  const relative = path.relative(engineRoot, root);
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return true;
  const bin = await lstat(path.join(root, 'bin', 'singularity-flow.mjs')).catch(() => null);
  if (!bin?.isFile()) return false;
  const manifest = path.join(root, 'package.json');
  try {
    const meta = await lstat(manifest);
    return meta.isFile() && meta.size <= 256 * 1024 && JSON.parse(await readFile(manifest, 'utf8')).name === 'singularity-flow';
  }
  catch { return false; }
}

/** Read the selector as stored. The Story index checks its checkout before the browser uses it. */
export async function activeStorySelection(environment) {
  const home = environment.HOME || environment.USERPROFILE || os.homedir();
  const { activeWorkspaceFile, readActiveWorkspaceContext } = await import('../workspace-context.mjs');
  const selection = await readActiveWorkspaceContext(activeWorkspaceFile(environment, home), null, { refresh: false });
  if (!selection?.storyId) return null;
  const { storyId, workspaceId, repositoryId, checkoutPath, repositoryPath, selectionStatus } = selection;
  const target = checkoutPath ?? repositoryPath;
  return { workId: storyId, workspaceId, repositoryId,
    checkoutPath: typeof target === 'string' && path.isAbsolute(target) ? await realpath(target).catch(() => null) : null,
    stale: selectionStatus === 'stale' };
}

export function matchesActiveStory(entry, selection) {
  return entry?.workId === selection.workId && entry.checkoutPath === selection.checkoutPath
    && entry.workspace.id === selection.workspaceId && entry.repository.id === selection.repositoryId;
}
