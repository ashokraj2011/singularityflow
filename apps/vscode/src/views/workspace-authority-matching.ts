import { sameGitRepository } from '../repository-refresh-model.ts';
import type { WorkspaceEntry } from './workspaces-model.ts';

/** Match read-only choices from validated local manifests, never a Git health scan of every row. */
export function workspaceAuthorityChoices(entries: WorkspaceEntry[], authorityUrl: string): {
  matchingPaths: string[];
  unreadable: WorkspaceEntry[];
} {
  const matchingPaths: string[] = [];
  const unreadable: WorkspaceEntry[] = [];
  for (const entry of entries) {
    if (entry.archivedAt) continue;
    if (entry.manifestStatus !== 'read') {
      unreadable.push(entry);
      continue;
    }
    const url = entry.capabilityAuthorityUrl?.trim() || entry.leadRepositoryUrl?.trim();
    if (!url) {
      unreadable.push(entry);
    } else if (sameGitRepository(url, authorityUrl)) {
      matchingPaths.push(entry.path);
    }
  }
  return { matchingPaths, unreadable };
}
