import { captureExecutionContext, boundExecutionContextRoot, findWorkspaceMembership } from '../execution-context.mjs';
import { workspaceCheckoutInventory, planWorkspaceCheckoutCleanup, applyWorkspaceCheckoutCleanup } from '../workspace-checkout-inventory.mjs';
import { readActiveWorkspaceContext, activeWorkspaceFile, workspaceRegistryFile, buildWorkspaceContext } from '../workspace-context.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { repoRoot } from '../git.mjs';
import path from 'node:path';
import { readWorkspace, workspaceRepositoryPath } from '../workspace-manifest.mjs';

export async function run(positionals, options) {
  const action = positionals[1];
  const reference = positionals[2] ?? optionString(options, 'workspace');
  if (action === 'context' && !reference) return console.log(JSON.stringify(await captureExecutionContext(
    boundExecutionContextRoot() ?? repoRoot(process.cwd()), { fresh: true }), null, 2));
  const manifest = reference && path.isAbsolute(reference) ? await readWorkspace(reference) : null;
  const repositoryId = optionString(options, 'repository') ?? manifest?.leadRepository;
  if (manifest && !manifest.repositories[repositoryId]) throw new SingularityFlowError(
    `Repository '${repositoryId}' is not part of workspace '${manifest.name}'.`, { code: 'ACTIVE_WORKSPACE_REPOSITORY_REMOVED' });
  const selected = manifest ? { workspacePath: manifest.path,
    repositoryPath: workspaceRepositoryPath(manifest, manifest.repositories[repositoryId]) }
    : reference ? await buildWorkspaceContext(workspaceRegistryFile(), reference, {
    repositoryId: optionString(options, 'repository'), detectStory: false
  }) : boundExecutionContextRoot() ? await findWorkspaceMembership(boundExecutionContextRoot())
    : await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false });
  if (action === 'context') {
    const root = reference ? selected?.repositoryPath : boundExecutionContextRoot() ?? repoRoot(process.cwd());
    const member = await findWorkspaceMembership(root, { workspacePath: selected?.workspacePath });
    return console.log(JSON.stringify(await captureExecutionContext(root, { workspace: member, fresh: true }), null, 2));
  }
  if (!selected?.workspacePath) throw new SingularityFlowError('Select a workspace or pass its directory.', { code: 'WORKSPACE_SELECTION_REQUIRED' });
  if (action === 'retention') {
    const retention = await import('../workspace-retention.mjs');
    if (optionBoolean(options, 'heartbeat')) {
      const root = boundExecutionContextRoot() ?? repoRoot(process.cwd());
      await retention.touchWorkspaceCheckout(selected.workspacePath, root, {
        surface: optionString(options, 'surface'), pid: Number(optionString(options, 'pid')) });
      await (await import('../workspace-retention-background.mjs')).scheduleWorkspaceRetention(selected.workspacePath, { protect: [root] });
      return console.log(JSON.stringify({ status: 'registered', repositoryPath: root }));
    }
    const change = {};
    for (const [flag, key] of Object.entries({ 'completed-days': 'completedDays', 'cancelled-days': 'cancelledDays',
      'unused-clone-days': 'unusedCloneDays', 'interval-minutes': 'intervalMinutes' })) {
      if (options[flag] !== undefined) {
        const value = optionString(options, flag);
        if (!/^(?:0|[1-9][0-9]*)$/u.test(value ?? '')) throw new SingularityFlowError(`--${flag} requires an explicit non-negative integer.`);
        change[key] = Number(value);
      }
    }
    if (options.enabled !== undefined) {
      const enabled = optionString(options, 'enabled');
      if (!['true', 'false'].includes(enabled)) throw new SingularityFlowError('--enabled must be true or false.');
      change.enabled = enabled === 'true';
    }
    const settings = Object.keys(change).length ? await retention.saveWorkspaceRetention(selected.workspacePath, change)
      : await retention.workspaceRetentionSettings(selected.workspacePath);
    return console.log(JSON.stringify({ workspacePath: selected.workspacePath, settings }, null, 2));
  }
  if (action === 'cleanup' && optionBoolean(options, 'automatic')) {
    if (options.apply || options.confirm || options.purge) throw new SingularityFlowError('Automatic cleanup uses retention policy, not manual apply/purge flags.');
    return console.log(JSON.stringify(await (await import('../workspace-retention.mjs')).runWorkspaceRetention(
      selected.workspacePath, { force: optionBoolean(options, 'refresh'), protect: [boundExecutionContextRoot() ?? process.cwd()] }), null, 2));
  }
  const result = action === 'checkouts' ? await workspaceCheckoutInventory(selected.workspacePath)
    : optionBoolean(options, 'apply') ? await applyWorkspaceCheckoutCleanup(selected.workspacePath, optionString(options, 'confirm'), { purge: optionBoolean(options, 'purge') })
    : await planWorkspaceCheckoutCleanup(selected.workspacePath, { purge: optionBoolean(options, 'purge') });
  console.log(JSON.stringify(result, null, 2));
  return result;
}
