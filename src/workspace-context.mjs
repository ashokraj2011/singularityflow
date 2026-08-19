import os from 'node:os';
import path from 'node:path';
import { readFile, realpath, rm } from 'node:fs/promises';
import YAML from 'yaml';
import {
  forgetWorkspace, readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath, workspaceStatus
} from './workspace.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const ACTIVE_WORKSPACE_SCHEMA_VERSION = currentSchemaVersion('active-workspace');

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

/**
 * The workspace registry is a machine-local convenience index, not governed state. A repository
 * which explicitly declares an obsolete workflow version cannot be opened by any current surface,
 * so retaining it only produces the same blocking error on every launch. Drop that registration
 * (and an active selection pointing at it) without touching the workspace directory or clone.
 *
 * Missing workflow files stay registered: an uninitialized clone is a valid setup state. YAML that
 * cannot be parsed also stays registered so Configuration can expose the file for repair. Only an
 * unambiguous, successfully parsed non-v2 declaration is discarded. There is intentionally no
 * conversion path during this POC.
 */
export async function discardUnsupportedWorkflowWorkspaces(registryFile, selectionFile = null) {
  const entries = await readWorkspaceRegistry(registryFile);
  const removed = [];
  for (const entry of entries) {
    let lead = entry.leadRepositoryPath;
    if (!lead) {
      try {
        const workspace = await readWorkspace(entry.path);
        lead = workspaceRepositoryPath(workspace, workspace.repositories[workspace.leadRepository]);
      } catch { continue; }
    }
    let text;
    try { text = await readFile(path.join(lead, 'singularity', 'workflow.yml'), 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      continue;
    }
    let workflow;
    try { workflow = YAML.parse(text); }
    catch { continue; }
    if (workflow?.version === 2) continue;
    removed.push({
      id: entry.id,
      name: entry.name,
      path: entry.path,
      leadRepositoryPath: lead,
      version: workflow?.version ?? null,
      reason: workflow?.version == null
        ? 'workflow.yml does not declare version 2'
        : `workflow.yml declares unsupported version ${workflow.version}`
    });
    await forgetWorkspace(registryFile, entry.path);
  }

  if (selectionFile && removed.length) {
    let selected = null;
    try { selected = JSON.parse(await readFile(selectionFile, 'utf8')); } catch { /* absent is fine */ }
    if (selected && removed.some((entry) => entry.id === selected.workspaceId
      && (!selected.workspacePath || path.resolve(entry.path) === path.resolve(selected.workspacePath)))) {
      await rm(selectionFile, { force: true });
    }
  }
  return { removed, remaining: await readWorkspaceRegistry(registryFile) };
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
  const index = await buildRepositorySubjectIndex(repositoryPath);
  const resolved = resolveContext(index, { reference: branchName, kind: 'story', required: false });
  return resolved ? portableStoryId(resolved.id) : null;
}

export function workspacePromptLabel(context) {
  const workspace = String(context?.workspaceName ?? context?.workspaceId ?? 'Workspace').trim();
  const story = String(context?.storyId ?? '').trim();
  return `${workspace}${story ? ` / ${story}` : ''} >`;
}

export async function buildWorkspaceContext(registryFile, reference, {
  repositoryId = null,
  storyId = null,
  detectStory = true
} = {}) {
  const entry = await resolveWorkspaceReference(registryFile, reference);
  const workspace = await readWorkspace(entry.path);
  const status = await workspaceStatus(workspace.path);
  const selectedRepositoryId = String(repositoryId ?? workspace.leadRepository).trim();
  const repository = status.repositories.find((item) => item.id === selectedRepositoryId);
  if (!repository) {
    throw new SingularityFlowError(`Repository '${selectedRepositoryId}' is not part of workspace '${workspace.name}'.`);
  }
  const selectedStoryId = portableStoryId(storyId)
    ?? (detectStory ? await detectedStory(repository.absolutePath, repository.branch) : null);
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
    selected = readRecord('active-workspace', await readFile(selectionFile)).record;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SingularityFlowError(`Unable to read active workspace selection: ${error.message}`);
  }
  if (!selected.workspaceId) {
    throw new SingularityFlowError('The active workspace selection is invalid. Select the workspace again.');
  }
  if (!refresh) return { ...selected, prompt: workspacePromptLabel(selected) };
  const context = await buildWorkspaceContext(registryFile, selected.workspaceId, {
    repositoryId: selected.repositoryId,
    storyId: selected.storyId
  });
  return { ...context, selectedAt: selected.selectedAt ?? context.selectedAt };
}

/** Clear the local selection only when it points at the workspace being forgotten. */
export async function clearActiveWorkspaceContext(selectionFile, workspacePath) {
  let selected;
  try { selected = readRecord('active-workspace', await readFile(selectionFile)).record; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new SingularityFlowError(`Unable to read active workspace selection: ${error.message}`);
  }
  const selectedPath = selected?.workspacePath ? await canonical(selected.workspacePath) : null;
  const forgottenPath = await canonical(workspacePath);
  if (!selectedPath || selectedPath !== forgottenPath) return false;
  await rm(selectionFile, { force: true });
  return true;
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
