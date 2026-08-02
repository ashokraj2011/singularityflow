import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { readWorkspace, readWorkspaceRegistry, workspaceStatus } from './workspace.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';

export const ACTIVE_WORKSPACE_SCHEMA_VERSION = 1;

export function workspaceRegistryFile(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY
    || path.join(home, '.singularity-flow', 'workspaces.json'));
}

export function activeWorkspaceFile(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE
    || path.join(home, '.singularity-flow', 'active-workspace.json'));
}

function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

function portableStoryId(value) {
  const storyId = String(value ?? '').trim();
  if (!storyId) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(storyId)) {
    throw new SingularityFlowError('Story ID must be a portable Jira or work-item identifier.');
  }
  return storyId;
}

async function canonical(value) {
  const resolved = path.resolve(value);
  return realpath(resolved).catch(() => resolved);
}

export async function resolveWorkspaceReference(registryFile, reference) {
  const entries = (await readWorkspaceRegistry(registryFile)).filter((entry) => !entry.archivedAt);
  if (!entries.length) {
    throw new SingularityFlowError('No workspaces are saved. Create or open a workspace in Singularity Flow first.');
  }
  const requested = String(reference ?? '').trim();
  if (!requested) {
    if (entries.length === 1) return entries[0];
    throw new SingularityFlowError('Choose a workspace by ID, name, Jira anchor, or directory.');
  }

  const requestedPath = requested.includes(path.sep) || path.isAbsolute(requested)
    ? await canonical(requested)
    : null;
  const key = normalized(requested);
  const matches = entries.filter((entry) => {
    if (requestedPath && entry.path === requestedPath) return true;
    return [entry.id, entry.name, entry.anchorKey].some((value) => normalized(value) === key);
  });
  if (!matches.length) {
    throw new SingularityFlowError(`Workspace '${requested}' is not saved. Run 'singularity-flow workspace list'.`);
  }
  if (matches.length > 1) {
    throw new SingularityFlowError(`Workspace reference '${requested}' is ambiguous. Use its workspace ID or full directory.`);
  }
  return matches[0];
}

async function detectedStory(repositoryPath, branchName) {
  if (!branchName) return null;
  for (const directory of ['singularity/work-items', '.singularity/work-items']) {
    const stateFile = path.join(repositoryPath, directory, branchName, 'state.json');
    if (!existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      const candidate = state?.workItem?.id ?? state?.workflow?.workItem?.id ?? branchName;
      return portableStoryId(candidate);
    } catch {
      return portableStoryId(branchName);
    }
  }
  return null;
}

export function workspacePromptLabel(context) {
  const workspace = String(context?.workspaceName ?? context?.workspaceId ?? 'Workspace').trim();
  const story = String(context?.storyId ?? '').trim();
  return `${workspace}${story ? ` / ${story}` : ''} >`;
}

export async function buildWorkspaceContext(registryFile, reference, {
  repositoryId = null,
  storyId = null
} = {}) {
  const entry = await resolveWorkspaceReference(registryFile, reference);
  const workspace = await readWorkspace(entry.path);
  const status = await workspaceStatus(workspace.path);
  const selectedRepositoryId = String(repositoryId ?? workspace.leadRepository).trim();
  const repository = status.repositories.find((item) => item.id === selectedRepositoryId);
  if (!repository) {
    throw new SingularityFlowError(`Repository '${selectedRepositoryId}' is not part of workspace '${workspace.name}'.`);
  }
  const selectedStoryId = portableStoryId(storyId) ?? await detectedStory(repository.absolutePath, repository.branch);
  const context = {
    schemaVersion: ACTIVE_WORKSPACE_SCHEMA_VERSION,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePath: workspace.path,
    anchorKey: workspace.anchor.key,
    repositoryId: repository.id,
    repositoryPath: repository.absolutePath,
    repositoryState: repository.state,
    branch: repository.branch,
    capabilities: [...(workspace.capabilities ?? [])],
    repositoryCapabilities: [...(workspace.repositories[repository.id]?.capabilities ?? [])],
    storyId: selectedStoryId,
    selectedAt: new Date().toISOString()
  };
  return { ...context, prompt: workspacePromptLabel(context) };
}

export async function activateWorkspaceContext(registryFile, selectionFile, reference, options = {}) {
  const context = await buildWorkspaceContext(registryFile, reference, options);
  await writeAtomic(selectionFile, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  return context;
}

export async function readActiveWorkspaceContext(selectionFile, registryFile, { refresh = true } = {}) {
  let selected;
  try {
    selected = JSON.parse(await readFile(selectionFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SingularityFlowError(`Unable to read active workspace selection: ${error.message}`);
  }
  if (selected?.schemaVersion !== ACTIVE_WORKSPACE_SCHEMA_VERSION || !selected.workspaceId) {
    throw new SingularityFlowError('The active workspace selection is invalid. Select the workspace again.');
  }
  if (!refresh) return { ...selected, prompt: workspacePromptLabel(selected) };
  const context = await buildWorkspaceContext(registryFile, selected.workspaceId, {
    repositoryId: selected.repositoryId,
    storyId: selected.storyId
  });
  return { ...context, selectedAt: selected.selectedAt ?? context.selectedAt };
}

export async function workspaceContextForRepository(repositoryRoot, selectionFile, registryFile) {
  // Session-start hooks have a short timeout and may run in workspaces with many repositories.
  // The launcher/switch command already verified and refreshed this selection, so matching the
  // persisted repository here avoids a status scan of every clone on each Copilot startup.
  const context = await readActiveWorkspaceContext(selectionFile, registryFile, { refresh: false }).catch(() => null);
  if (!context) return null;
  const root = await canonical(repositoryRoot);
  const repository = await canonical(context.repositoryPath);
  return root === repository ? context : null;
}
