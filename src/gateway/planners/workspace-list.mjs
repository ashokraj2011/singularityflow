/**
 * `workspace.list`: the workspaces this identity can see, from the registry and only the registry.
 * `[INT:CON-067]` `[INT:REQ-070]`
 *
 * The constraint is the interesting part. A chooser that scans for likely-looking directories is
 * both a privacy problem and a correctness one — it finds clones the user never registered, and a
 * similarly named folder becomes a workspace nobody chose. So the registry is the whole world here,
 * and a workspace that is not in it does not appear, however obviously it exists on disk.
 *
 * §8.4 also asks for repository count, active-work count and health. Those are per-workspace reads
 * of manifests and lifecycle state, and this planner does not do them: it reports what the registry
 * knows and declares the rest as an evidence gap. A chooser that stalls for a second per workspace
 * is a chooser people route around, and a fabricated health badge is worse than an absent one.
 */
import { readWorkspaceRegistry } from '../../workspace.mjs';
import { readActiveWorkspaceContext, workspaceRegistryFile, activeWorkspaceFile } from '../../workspace-context.mjs';
import { noEffects, plannerNavigation, sflowResult } from '../result.mjs';

/** What §8.4 asks for that the registry alone cannot answer. Declared, never guessed. */
export const WORKSPACE_LIST_EVIDENCE_GAPS = Object.freeze(['repositoryCount', 'activeWorkCount', 'health']);

export async function workspaceList({ subject = null, env = process.env } = {}) {
  const registryFile = workspaceRegistryFile(env);
  const entries = (await readWorkspaceRegistry(registryFile)).filter((entry) => !entry.archivedAt);
  const active = await readActiveWorkspaceContext(activeWorkspaceFile(env), registryFile, { refresh: false })
    .catch(() => null);

  const workspaces = entries.map((entry) => ({
    id: entry.id,
    name: entry.name ?? entry.id,
    path: entry.path,
    anchorKey: entry.anchorKey ?? null,
    lastUsedAt: entry.lastUsedAt ?? null,
    /**
     * Matched on ID *and* path. The registry de-duplicates by path, so two workspaces created with
     * the same `--id` in different directories both keep it, and matching on ID alone marks every
     * one of them as the one being worked in — the single question this field exists to answer.
     */
    active: entry.id === active?.workspaceId
      && (!active?.workspacePath || entry.path === active.workspacePath),
    // Why this identity can see it: it is registered on this machine. There is no other route.
    visibleBecause: 'registered-on-this-machine'
  }));

  return sflowResult({
    kind: 'read',
    operation: { id: 'workspace.list', classification: 'read' },
    subject,
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots: { count: workspaces.length } },
    effects: noEffects(),
    why: [{
      code: 'workspace.from-registry',
      source: 'deterministic',
      reference: registryFile,
      slots: { count: String(workspaces.length) }
    }],
    warnings: WORKSPACE_LIST_EVIDENCE_GAPS.map((field) => ({
      code: 'workspace.evidence-gap',
      source: 'unavailable',
      slots: { field }
    })),
    next: workspaces.map((workspace, index) => plannerNavigation({
      handle: `workspace:${workspace.id}`,
      id: `workspace:${workspace.id}`,
      label: workspace.name,
      rank: index,
      kind: 'candidates',
      reasonCode: 'workspace.selectable',
      confirmation: 'host-confirm',
      interaction: 'navigation',
      // Switching is a separate resolved operation. This is a list, not a set of switch buttons.
      executable: false,
      fallback: { label: 'Switch workspace', command: `sflow workspace use ${workspace.id}` }
    }, 'workspace.switch', { workspaceId: workspace.id })),
    // An empty registry is an answer, and the guidance for it is attach or materialize `[INT:REQ-154]`.
    restState: workspaces.length ? null : 'informational',
    data: { workspaces, registryFile, evidenceGaps: [...WORKSPACE_LIST_EVIDENCE_GAPS] }
  });
}
