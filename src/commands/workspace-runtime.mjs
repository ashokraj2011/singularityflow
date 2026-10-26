import { activeWorkspaceFile, workspaceRegistryFile, readActiveWorkspaceContext, buildWorkspaceContext } from '../workspace-context.mjs';
import { workspaceRuntimeInventory, resolveWorkspaceRuntimeTarget } from '../workspace-runtime.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import path from 'node:path';

export async function run(positionals = [], options = {}) {
  const allowed = new Set(['workspace', 'target', 'changes', 'json', 'for-agent', 'timings']);
  if (positionals.length > 2 || Object.keys(options).some(key => !allowed.has(key))) throw new SingularityFlowError('Use workspace runtime [--workspace ID-OR-PATH] [--target ID] --json.');
  const reference = optionString(options, 'workspace');
  const selected = reference ? path.isAbsolute(reference) ? { workspacePath: reference }
    : await buildWorkspaceContext(workspaceRegistryFile(), reference, { detectStory: false })
    : await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false });
  if (!selected?.workspacePath) throw new SingularityFlowError('Select a workspace first.', { code: 'WORKSPACE_SELECTION_REQUIRED' });
  const target = optionString(options, 'target');
  const result = target ? await resolveWorkspaceRuntimeTarget(selected.workspacePath, target) : await workspaceRuntimeInventory(selected.workspacePath);
  if (optionBoolean(options, 'changes')) {
    if (!target) throw new SingularityFlowError('Choose --target before listing checkout changes.');
    const { worktreeStatusDetail } = await import('../git.mjs');
    const status = worktreeStatusDetail(result.checkoutPath);
    result.changes = status.entries.slice(0, 500).map(entry => ({ path: entry.path.kind === 'utf8' ? entry.path.value : null,
      display: entry.path.display, status: entry.xy?.raw ?? entry.type }));
    result.changesTruncated = status.entries.length > 500;
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}
