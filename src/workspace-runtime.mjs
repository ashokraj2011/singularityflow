/** Local inventory for Run & Test. Opening the page never fetches, backfills or scans Git history. */
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readWorkspace, workspaceRepositoryPath } from './workspace-manifest.mjs';
import { readStoryIndex, indexedCheckoutAt } from './story-index.mjs';
import { SingularityFlowError } from './util.mjs';

const key = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export async function workspaceRuntimeInventory(workspacePath) {
  const workspace = await readWorkspace(workspacePath);
  const canonicalWorkspace = await realpath(workspace.path);
  const index = await readStoryIndex();
  const targets = [];
  const locations = new Map();
  const canonical = location => {
    if (!locations.has(location)) locations.set(location, realpath(location).catch(() => path.resolve(location)));
    return locations.get(location);
  };
  const add = async (repositoryId, checkoutPath, story = null) => {
    const root = path.resolve(checkoutPath);
    // Inventory must not hydrate/read a cloud-backed .git pointer. Verify only on selection.
    const marker = await lstat(path.join(root, '.git')).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
    const available = marker && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile() && marker.size <= 4096);
    targets.push({ id: key([workspace.path, repositoryId, root, story?.workId ?? null]),
      repositoryId, checkoutPath: root, workId: story?.workId ?? null,
      title: story?.title ?? workspace.repositories[repositoryId]?.name ?? repositoryId,
      branch: story?.branch ?? workspace.repositories[repositoryId]?.branch ?? null,
      phase: story?.phase ?? null, storyStatus: story?.storyStatus ?? null,
      role: story ? story.role ?? 'story' : 'base', available: Boolean(available),
      ...(story?.lifecycle?.checkoutPath ? { lifecycleCheckoutPath: story.lifecycle.checkoutPath } : {}) });
  };
  for (const [id, repository] of Object.entries(workspace.repositories)) await add(id, workspaceRepositoryPath(workspace, repository));
  for (const entry of index.entries) {
    if (!entry.workspace?.path || !same(await canonical(entry.workspace.path), canonicalWorkspace)
        || !Object.hasOwn(workspace.repositories, entry.repository?.id)) continue;
    await add(entry.repository.id, entry.checkoutPath, entry);
  }
  return { schemaVersion: 1, resultType: 'workspace-runtime-inventory', workspace: { id: workspace.id, name: workspace.name, path: workspace.path },
    targets, inventory: 'local-recorded', remoteChecked: false, materializesCheckout: false };
}

/** Resolve an engine-issued target again; the webview supplies an ID, never a filesystem path. */
export async function resolveWorkspaceRuntimeTarget(workspacePath, id) {
  const inventory = await workspaceRuntimeInventory(workspacePath);
  const target = inventory.targets.find(item => item.id === id);
  if (!target || !target.available) throw new SingularityFlowError('This checkout is unavailable. Refresh Run & Test or attach the Story to prepare its checkout.',
    { code: 'WORKSPACE_RUNTIME_TARGET_UNAVAILABLE' });
  const root = await realpath(target.checkoutPath);
  if (target.workId) {
    const entry = await indexedCheckoutAt(root);
    if (!entry || entry.workId !== target.workId || entry.repository.id !== target.repositoryId) {
      throw new SingularityFlowError('The selected Story checkout changed. Refresh Run & Test; nothing ran.', { code: 'WORKSPACE_RUNTIME_TARGET_CHANGED' });
    }
    Object.assign(target, { branch: entry.branch, phase: entry.phase, storyStatus: entry.storyStatus });
  }
  const { findWorkspaceMembership, captureExecutionContext } = await import('./execution-context.mjs');
  const member = await findWorkspaceMembership(root, { workspacePath: inventory.workspace.path });
  if (!member || member.repositoryId !== target.repositoryId) throw new SingularityFlowError('The checkout no longer belongs to this workspace repository.',
    { code: 'WORKSPACE_RUNTIME_TARGET_CHANGED' });
  const { resolveCapabilityApplication } = await import('./capability-application-context.mjs');
  let capabilities;
  try {
    const app = await resolveCapabilityApplication(root, { readApplication: false });
    capabilities = [{ id: app.capabilityId, name: app.capability?.name ?? app.capabilityId, kind: 'delivery', repository: target.repositoryId, repositories: app.repositories, sourceRoots: app.capability?.sourceRoots ?? [], children: [] }];
  } catch (error) {
    if (error.code !== 'CAPABILITY_SELECTION_REQUIRED') throw error;
    capabilities = (error.details?.capabilityIds ?? []).map(id => ({ id, name: id, kind: 'delivery', repository: target.repositoryId, children: [] }));
  }
  return { ...target, capabilities, checkoutPath: root, context: await captureExecutionContext(root, { workspace: member, fresh: true }) };
}
