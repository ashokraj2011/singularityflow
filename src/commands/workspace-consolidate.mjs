/**
 * `workspace consolidate [WORKSPACE] [--repository ID]... [--confirm-plan PLAN-ID] [--json]`: one
 * clone per workspace repository (workspace-consolidation.mjs). Without --confirm-plan it only
 * previews: the canonical clone, each Story checkout that would move and why any other cannot.
 * With the preview's plan ID it moves them, after the same checks again.
 */
import path from 'node:path';
import { boundExecutionContextRoot } from '../execution-context-scope.mjs';
import { optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const OPTIONS = new Set(['json', 'repository', 'confirm-plan', 'workspace', 'timings', 'for-agent']);

/** The workspace a directory, ID or name names, else the bound or active one (as `workspace cleanup`). */
async function selectedWorkspacePath(reference) {
  if (reference && path.isAbsolute(reference)) return (await (await import('../workspace-manifest.mjs')).readWorkspace(reference)).path;
  const contexts = await import('../workspace-context.mjs');
  const selected = reference
    ? await contexts.buildWorkspaceContext(contexts.workspaceRegistryFile(), reference, { detectStory: false })
    : boundExecutionContextRoot()
      ? await (await import('../execution-context.mjs')).findWorkspaceMembership(boundExecutionContextRoot())
      : await contexts.readActiveWorkspaceContext(contexts.activeWorkspaceFile(), contexts.workspaceRegistryFile(), { refresh: false });
  if (!selected?.workspacePath) throw new SingularityFlowError('Select a workspace or pass its directory: singularity-flow workspace consolidate <WORKSPACE>.',
    { code: 'WORKSPACE_SELECTION_REQUIRED' });
  return selected.workspacePath;
}

function print(result) {
  const verb = result.applied ? 'Workspace consolidation' : 'Workspace consolidation preview';
  console.log(`${verb}: ${result.status} · ${result.workspace.name} · ${result.workspace.path}`);
  for (const entry of result.repositories) {
    if (!entry.canonical) { console.log(`${entry.repositoryId}: one clone; nothing to consolidate.`); continue; }
    console.log(`${entry.repositoryId}: canonical clone ${entry.canonical.path}`);
    for (const clone of entry.clones) console.log(`  Other clone ${clone.path} (${clone.branch}): ${clone.storyCheckouts} Story checkout${clone.storyCheckouts === 1 ? '' : 's'}`);
    const moves = result.applied ? result.moved.filter((move) => entry.moves.some((item) => item.checkoutPath === move.checkoutPath)) : entry.moves;
    for (const move of moves) {
      console.log(`  ${result.applied ? 'Moved' : 'Moves'} ${move.workId}${move.role === 'secondary' ? ` (${entry.repositoryId})` : ''} on ${move.branch}: ${move.checkoutPath}`);
    }
    for (const item of entry.refused) {
      console.log(`  Stays${item.workId ? ` ${item.workId}` : ''}: ${item.checkoutPath}: ${item.message}.`);
    }
    for (const item of entry.pointers) console.log(`  ${result.applied ? 'Set aside' : 'Sets aside'} the branch-download pointer of ${item.clone}; the clone itself stays.`);
  }
  if (result.applied) {
    console.log(`Story index: ${result.storyIndex.updated} updated${result.storyIndex.failed ? `, ${result.storyIndex.failed} not updated (it is rebuilt on the next lookup)` : ''}.`);
    if (result.nextAction) console.log(`A clone that owns nothing can be retired after its own preview: ${result.nextAction}`);
    return;
  }
  if (result.planId) {
    console.log(`Plan: ${result.planId}`);
    console.log('Nothing was changed. A move changes no file in the checkout and deletes nothing; checkouts that stay are left as they are.');
    console.log(`Apply it: ${result.nextAction}`);
  } else console.log(result.status === 'current' ? 'Every Story checkout is already in its declared clone.' : 'Nothing can move yet; nothing was changed.');
}

export async function run(positionals = [], options = {}) {
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) throw new SingularityFlowError(`workspace consolidate takes --repository, --confirm-plan and --json, not --${key}.`,
      { code: 'WORKSPACE_CONSOLIDATE_OPTION_UNSUPPORTED' });
  }
  if (positionals.length > 3) throw new SingularityFlowError('workspace consolidate takes at most one workspace.',
    { code: 'WORKSPACE_CONSOLIDATE_OPTION_UNSUPPORTED' });
  const workspacePath = await selectedWorkspacePath(positionals[2] ?? optionString(options, 'workspace'));
  const repositoryIds = optionStrings(options, 'repository');
  const planId = optionString(options, 'confirm-plan');
  const engine = await import('../workspace-consolidation.mjs');
  const result = planId ? await engine.applyWorkspaceConsolidation(workspacePath, planId, { repositoryIds })
    : await engine.planWorkspaceConsolidation(workspacePath, { repositoryIds });
  if (options.json === true) console.log(JSON.stringify(result, null, 2));
  else print(result);
  return result;
}
