/**
 * The workspaces this machine knows, as whole commands a refusal offers, never `<WORKSPACE>` [audit 2026-11-19,
 * entry 13]. Loaded only on the refusals and reads that name them; an unreadable registry offers none.
 */
import { readWorkspaceRegistry } from './workspace-manifest.mjs';

/** Last opened first, archived ones left out: `[{ id, name }]`, at most five. */
export async function knownWorkspaces(file) {
  try {
    return (await readWorkspaceRegistry(file)).filter((entry) => !entry.archivedAt && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.id))
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt)).slice(0, 5).map((entry) => ({ id: entry.id, name: entry.name }));
  } catch { return []; }
}

/** `workspace use` for each workspace this machine knows but `except` (an ID), three at most. */
export async function workspaceUseCommands(file, except = null) {
  return (await knownWorkspaces(file)).filter((entry) => entry.id !== except).slice(0, 3).map((entry) => `singularity-flow workspace use ${entry.id}`);
}
