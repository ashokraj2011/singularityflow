/**
 * The capability portfolio summary shown above the editable map.
 *
 * A capability is an organisational unit, not a second lifecycle aggregate. The dashboard therefore
 * reports facts the capability map actually owns (coverage, delivery repositories, Jira routing and
 * teams) and keeps repository-wide lifecycle counts clearly labelled as portfolio signals.
 */
import type { CapabilityNode, RepositorySnapshot } from '../cli/snapshot.ts';
import { flattenCapabilities } from './capability-model.ts';

export interface CapabilityRootSummary {
  id: string;
  name: string;
  kind: string;
  capabilities: number;
  deliveryCapabilities: number;
  repositories: string[];
  jiraProjects: string[];
  teams: string[];
}

export interface CapabilityDashboard {
  capabilities: number;
  deliveryCapabilities: number;
  repositories: number;
  jiraRoutes: number;
  openWork: number;
  approvals: number;
  diagnostics: 'healthy' | 'needs-attention' | 'unknown';
  worldModel: 'available' | 'missing';
  roots: CapabilityRootSummary[];
}

function active(status: unknown): boolean {
  return !['complete', 'completed', 'closed', 'cancelled', 'canceled'].includes(
    String(status ?? '').toLowerCase()
  );
}

function rootSummary(root: CapabilityNode): CapabilityRootSummary {
  const rows = flattenCapabilities([root]);
  const repositories = new Set<string>();
  const jiraProjects = new Set<string>();
  const teams = new Set<string>();
  for (const row of rows) {
    const owned = row.repositories?.length
      ? row.repositories
      : (row.repository ? [row.repository] : []);
    owned.forEach((repository) => repositories.add(repository));
    if (row.jira?.projectKey) jiraProjects.add(row.jira.projectKey);
    (row.teams ?? []).forEach((team) => teams.add(team));
  }
  return {
    id: root.id,
    name: root.name,
    kind: root.kind,
    capabilities: rows.length,
    deliveryCapabilities: rows.filter((row) => row.kind === 'delivery').length,
    repositories: [...repositories].sort(),
    jiraProjects: [...jiraProjects].sort(),
    teams: [...teams].sort()
  };
}

export function buildCapabilityDashboard(snapshot: RepositorySnapshot | null): CapabilityDashboard {
  const tree = snapshot?.capabilityMap?.capabilities ?? [];
  const rows = flattenCapabilities(tree);
  const repositories = new Set<string>();
  const jiraProjects = new Set<string>();
  for (const row of rows) {
    const owned = row.repositories?.length
      ? row.repositories
      : (row.repository ? [row.repository] : []);
    owned.forEach((repository) => repositories.add(repository));
    if (row.jira?.projectKey) jiraProjects.add(row.jira.projectKey);
  }

  const openWork = [
    ...(snapshot?.workItems ?? []),
    ...(snapshot?.initiatives ?? [])
  ].filter((item) => active(item.status)).length;

  return {
    capabilities: rows.length,
    deliveryCapabilities: rows.filter((row) => row.kind === 'delivery').length,
    repositories: repositories.size,
    jiraRoutes: jiraProjects.size,
    openWork,
    approvals: snapshot?.approvalInbox?.count ?? 0,
    diagnostics: snapshot?.diagnostics?.healthy == null
      ? 'unknown'
      : snapshot.diagnostics.healthy ? 'healthy' : 'needs-attention',
    worldModel: snapshot?.worldModel?.generatedAt ? 'available' : 'missing',
    roots: tree.map(rootSummary)
  };
}
