import { compareStoryCreation, storyCreatorName } from './story-presentation.mjs';
/** Machine-local advisory roster. No Git/network before a hit; writes never consume this result. */
import path from 'node:path';
import os from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import { cachedSessionListing, configuredRemoteUrls, repositoryCheckStatus, withFreshRepositoryChecks } from './repository-check-cache.mjs';
import { gitFactCheckout } from './git-fact-cache.mjs';
import { activeWorkspaceFile, workspaceRegistryFile, resolveWorkspaceReference } from './workspace-context.mjs';
import { readWorkspace, workspaceRepositoryPath } from './workspace-manifest.mjs';
import { optionBoolean, optionString } from './util.mjs';

// Options that change how a listing is shown or whether it is refreshed, never which listing it is.
const LISTING_PRESENTATION = ['json', 'for-agent', 'table', 'diagnostics', 'timings', 'refresh'];

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
  // The remote-tracking refs this read's own fetch moves (A2): it may change them and still keep its
  // answer, stamped as they stand after it; a change to anything else while it ran is not kept.
  const selfUpdated = [];
  for (const root of roots) {
    const git = gitFactCheckout(root);
    if (!git) continue;
    files.push(git.marker, path.join(git.gitDir, 'HEAD'), path.join(git.gitDir, 'index'),
      path.join(git.commonDir, 'config'), path.join(git.commonDir, 'packed-refs'),
      path.join(git.commonDir, 'singularity-flow/cache/repository-checks/refresh'),
      path.join(root, 'singularity/workflow.yml'), path.join(root, 'singularity/portfolio.yml'));
    selfUpdated.push(path.join(git.commonDir, 'refs'), path.join(git.commonDir, 'refs/remotes'));
    // Observe remote namespace directories, not application branches or their histories: the ones
    // there and the configured remotes', so a first fetch that creates them does not unsettle the read.
    const remotes = new Set((configuredRemoteUrls(root) ?? []).map((entry) => entry.remote));
    for (const entry of await readdir(path.join(git.commonDir, 'refs/remotes'), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) remotes.add(entry.name);
    }
    for (const remote of remotes) {
      if (!remote || remote.includes('/') || remote.includes('\\') || remote === '.' || remote === '..') continue;
      const namespace = path.join(git.commonDir, 'refs/remotes', remote);
      selfUpdated.push(namespace, path.join(namespace, 'state'), path.join(namespace, 'sflow'), path.join(namespace, 'sflow/config'));
    }
  }
  files.push(...selfUpdated);
  const identity = { cwd, positionals, options: Object.entries(options)
    .filter(([key]) => !LISTING_PRESENTATION.includes(key))
    .sort(([a], [b]) => a.localeCompare(b)) };
  // The read that produced this listing, replayed to refresh it behind a stale answer.
  const { indexReadArgv } = await import('./index-refresh-launcher.mjs');
  const argv = indexReadArgv(positionals, options, LISTING_PRESENTATION);
  const refreshRecipe = argv ? { argv, cwd } : null;
  // A listing of a repository named by URL is that repository's, never the checkout it ran in (A6).
  const repositoryUrl = optionString(options, 'repository-url');
  const authority = repositoryUrl ? { repositoryUrl, configurationUrl: optionString(options, 'configuration-url') ?? null } : null;
  const inspect = () => cachedSessionListing(cwd, { identity, files: [...new Set(files)], settingsRoot, refreshRecipe,
    selfUpdated, authority }, read);
  const value = await (optionBoolean(options, 'refresh') ? withFreshRepositoryChecks(inspect) : inspect());
  if (!value?.discovered) return value;
  const status = repositoryCheckStatus(cwd);
  // A record served from the cache was fetched when it was checked, not now.
  const reused = ['cache', 'last-known', 'shared'].includes(status.source);
  return { ...value, discovered: { ...value.discovered, items: value.discovered.items.map(item => ({ ...item, createdBy: storyCreatorName(item.createdBy) })).sort(compareStoryCreation), ...(reused ? { fetched: false } : {}), listingSnapshot: {
    ...status, source: status.source === 'fresh' && value.discovered.fetched === false ? 'local' : status.source,
    scope: 'session-candidate-listing', advisory: true,
    remoteCheckedAt: value.discovered.fetched === true ? status.checkedAt : null,
    refresh: { command: 'singularity-flow session candidates --refresh --diagnostics --json', copilotCommand: '/sf-session --refresh' }
  } } };
}
