import { compareStoryCreation, storyCreatorName } from './story-presentation.mjs';
/** Machine-local advisory roster. No Git/network before a hit; writes never consume this result. */
import path from 'node:path';
import os from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import { cachedSessionListing, repositoryCheckStatus, withFreshRepositoryChecks } from './repository-check-cache.mjs';
import { gitFactCheckout } from './git-fact-cache.mjs';
import { activeWorkspaceFile, workspaceRegistryFile, resolveWorkspaceReference } from './workspace-context.mjs';
import { readWorkspace, workspaceRepositoryPath } from './workspace-manifest.mjs';
import { optionBoolean, optionString } from './util.mjs';

export async function sessionListingSnapshot(positionals, options, read) {
  const cwd = process.cwd();
  const selectionFile = activeWorkspaceFile(), registryFile = workspaceRegistryFile();
  const files = [selectionFile, registryFile, path.join(os.homedir(), '.gitconfig'),
    process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_SYSTEM,
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'git/config')].filter(Boolean);
  const roots = new Set([cwd]);
  let settingsRoot = cwd;
  // Resolve only manifest identities here. Authority resolution and all Git remain on the miss path.
  try {
    const selector = optionString(options, 'workspace');
    const selected = selector ? await resolveWorkspaceReference(registryFile, selector) : null;
    const active = JSON.parse(await readFile(selectionFile, 'utf8').catch(() => 'null'));
    const workspacePath = selected?.path ?? (!selector ? active?.workspacePath : null);
    if (workspacePath) {
      files.push(path.join(workspacePath, 'workspace.json'));
      const workspace = await readWorkspace(workspacePath);
      const repositoryId = optionString(options, 'repository') ?? active?.repositoryId ?? workspace.leadRepository;
      const member = workspace.repositories[repositoryId];
      if (member) { settingsRoot = workspaceRepositoryPath(workspace, member); roots.add(settingsRoot); }
      if (active?.workspacePath && path.resolve(active.workspacePath) === path.resolve(workspacePath)
          && active.repositoryId === repositoryId) {
        for (const root of [active.repositoryPath, active.canonicalRepositoryPath, active.checkoutPath]) if (root) roots.add(root);
      }
    }
  } catch { /* The original command diagnoses invalid/ambiguous selection, never the cache. */ }
  for (const root of roots) {
    const git = gitFactCheckout(root);
    if (!git) continue;
    files.push(git.marker, path.join(git.gitDir, 'HEAD'), path.join(git.gitDir, 'index'),
      path.join(git.commonDir, 'config'), path.join(git.commonDir, 'packed-refs'),
      path.join(git.commonDir, 'refs'), path.join(git.commonDir, 'refs/remotes'),
      path.join(git.commonDir, 'singularity-flow/cache/repository-checks/refresh'),
      path.join(root, 'singularity/workflow.yml'), path.join(root, 'singularity/portfolio.yml'));
    // Observe remote namespace directories, not application branches or their histories.
    for (const entry of await readdir(path.join(git.commonDir, 'refs/remotes'), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) files.push(path.join(git.commonDir, 'refs/remotes', entry.name),
        path.join(git.commonDir, 'refs/remotes', entry.name, 'state'),
        path.join(git.commonDir, 'refs/remotes', entry.name, 'sflow/config'));
    }
  }
  const identity = { cwd, positionals, options: Object.entries(options)
    .filter(([key]) => !['json', 'for-agent', 'table', 'diagnostics', 'timings', 'refresh'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)) };
  const inspect = () => cachedSessionListing(cwd, { identity, files: [...new Set(files)], settingsRoot }, read);
  const value = await (optionBoolean(options, 'refresh') ? withFreshRepositoryChecks(inspect) : inspect());
  if (!value?.discovered) return value;
  const status = repositoryCheckStatus(cwd);
  return { ...value, discovered: { ...value.discovered, items: value.discovered.items.map(item => ({ ...item, createdBy: storyCreatorName(item.createdBy) })).sort(compareStoryCreation), ...(status.source === 'cache' ? { fetched: false } : {}), listingSnapshot: {
    ...status, source: status.source === 'fresh' && value.discovered.fetched === false ? 'local' : status.source,
    scope: 'session-candidate-listing', advisory: true,
    remoteCheckedAt: value.discovered.fetched === true ? status.checkedAt : null,
    refresh: { command: 'singularity-flow session candidates --refresh --diagnostics --json', copilotCommand: '/sf-session --refresh' }
  } } };
}
