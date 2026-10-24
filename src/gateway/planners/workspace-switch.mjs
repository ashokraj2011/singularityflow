/**
 * `workspace.switch` and `workspace.materialize`. `[INT:CON-067]` `[INT:CON-068]` `[INT:REQ-071]`
 *
 * Switching chooses from the configured workspace registry and nothing else: a reference that is
 * not a registered workspace is refused, never matched against a similarly named folder. Its whole
 * effect is which workspace the next question is about — `contextChanged`, and every governed
 * effect false — and the executor reaches the same selection service `sflow workspace use` does, so
 * the two paths cannot disagree about what "the active workspace" means `[INT:CON-021]`.
 *
 * Materialization is a separate plan because it writes to disk and reaches the network. The
 * planner names the target, the repositories that are not on this machine, and the remotes they
 * would come from with any credential removed; it has no storage estimate to give, and says so
 * rather than inventing one.
 */
import { SingularityFlowError } from '../../util.mjs';
import { planDescriptor } from '../plan-descriptor.mjs';
import { effects, sflowResult } from '../result.mjs';

async function registryEntry(workspaceId, env) {
  const [{ readWorkspaceRegistry }, { workspaceRegistryFile }] = await Promise.all([
    import('../../workspace.mjs'), import('../../workspace-context.mjs')
  ]);
  const registryFile = workspaceRegistryFile(env);
  const entries = (await readWorkspaceRegistry(registryFile)).filter((entry) => !entry.archivedAt);
  // Exact ID only. A name, anchor or path is a lookup a person types; a gateway argument is not.
  const entry = entries.find((candidate) => candidate.id === workspaceId);
  if (!entry) {
    throw new SingularityFlowError(`'${workspaceId}' is not a registered workspace.`, {
      code: 'WORKSPACE_NOT_REGISTERED', details: { nextAction: 'sflow workspace list' }
    });
  }
  return { entry, registryFile };
}

export async function workspaceSwitchPlan({ arguments: args = {}, env = process.env } = {}) {
  const { entry } = await registryEntry(args.workspaceId, env);
  const { readActiveWorkspaceContext, activeWorkspaceFile, workspaceRegistryFile } = await import('../../workspace-context.mjs');
  const current = await readActiveWorkspaceContext(activeWorkspaceFile(env), workspaceRegistryFile(env), { refresh: false })
    .catch(() => null);
  if (current?.workspaceId === entry.id && (!current.workspacePath || current.workspacePath === entry.path)) {
    throw new SingularityFlowError(`'${entry.id}' is already the selected workspace.`, { code: 'WORKSPACE_ALREADY_SELECTED' });
  }
  return planDescriptor({
    effects: { contextChanged: true },
    idempotencyKey: `workspace.switch:${entry.id}:${current?.workspaceId ?? 'none'}`,
    preview: {
      action: 'select-workspace',
      workspace: { id: entry.id, name: entry.name ?? entry.id, path: entry.path },
      previous: current?.workspaceId ? { id: current.workspaceId } : null,
      // `[INT:CON-068]`: named so the confirmation is about these too.
      unchanged: ['approval authority', 'lifecycle state', 'pinned Story configuration', 'Git refs']
    }
  });
}

export async function workspaceSwitchExecute({ plan, env = process.env } = {}) {
  const { activateWorkspaceContext, activeWorkspaceFile, workspaceRegistryFile } = await import('../../workspace-context.mjs');
  const { workspace } = plan.review.preview;
  const context = await activateWorkspaceContext(workspaceRegistryFile(env), activeWorkspaceFile(env), workspace.id);
  return sflowResult({
    kind: 'read',
    operation: { id: 'workspace.switch', classification: 'mutation' },
    outcome: { status: 'succeeded', messageId: 'gateway.completed', slots: { workspace: context.workspaceId } },
    effects: effects({ contextChanged: true }),
    why: [{ code: 'workspace.selection-changed', source: 'deterministic', slots: { workspace: context.workspaceId } }],
    preserved: ['stateChanged', 'filesChanged', 'gitRefsChanged', 'publicationCreated', 'externalSystemsChanged']
      .map((scope) => ({ code: 'workspace.governed-state-untouched', source: 'deterministic', scope })),
    restState: 'complete',
    data: { workspace: { id: context.workspaceId, name: context.workspaceName, repositoryId: context.repositoryId } }
  });
}

/** A remote, without anything that could be a credential: scheme, host and path only. */
export function credentialFreeRemote(url) {
  const text = String(url ?? '');
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/u.exec(text);
  if (scp) return `${scp[1]}:${scp[2]}`;
  try {
    const parsed = new URL(text);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { return null; }
}

export async function workspaceMaterializePlan({ arguments: args = {}, env = process.env } = {}) {
  const { entry } = await registryEntry(args.workspaceId, env);
  if (args.targetPath !== entry.path) {
    throw new SingularityFlowError('A registered workspace materializes at its registered path.', {
      code: 'WORKSPACE_TARGET_MISMATCH', details: { registered: entry.path }
    });
  }
  const { readWorkspace, workspaceStatus } = await import('../../workspace.mjs');
  const workspace = await readWorkspace(entry.path);
  const status = await workspaceStatus(workspace.path, { level: 'readiness' });
  const missing = status.repositories.filter((repository) => repository.state !== 'ready');
  if (!missing.length) {
    throw new SingularityFlowError(`Every repository of '${entry.id}' is already on this machine.`, { code: 'WORKSPACE_ALREADY_MATERIALIZED' });
  }
  return planDescriptor({
    effects: { contextChanged: true, filesChanged: true, gitRefsChanged: true },
    idempotencyKey: `workspace.materialize:${entry.id}:${missing.map((repository) => repository.id).sort().join(',')}`,
    externalTargets: missing.map((repository) => ({ kind: 'git-remote', purpose: 'clone', repository: repository.id })),
    preview: {
      action: 'materialize-workspace',
      workspace: { id: entry.id, name: entry.name ?? entry.id },
      targetPath: entry.path,
      repositories: missing.map((repository) => ({
        id: repository.id,
        state: repository.state,
        remote: credentialFreeRemote(workspace.repositories?.[repository.id]?.repository?.url)
      })),
      network: 'clone each listed repository from its remote',
      storageEstimate: null
    }
  });
}
