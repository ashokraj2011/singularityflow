/**
 * The machine-local healers a first-run pass runs: each registered, bounded, and never recursive.
 *
 * A healer failure is reported, never thrown: machine-local derived state must not stop the
 * command that found it.
 */
import os from 'node:os';
import { workspaceBootstrapRoot } from './workspace-bootstrap.mjs';
import { workspaceRegistryFile } from './workspace-context.mjs';
import { healOrphanCloneStaging, healStaleWorkspaceRegistry } from './workspace.mjs';

export async function repairLocalState({
  environment = process.env,
  homeDirectory = os.homedir(),
  now = Date.now()
} = {}) {
  const registryFile = workspaceRegistryFile(environment, homeDirectory);
  const healers = [
    ['stale-workspace-registry', () => healStaleWorkspaceRegistry(registryFile), (result) => result.healed.length],
    ['orphan-bootstrap-staging', () => healOrphanCloneStaging(registryFile, {
      now, bootstrapRoot: workspaceBootstrapRoot(environment, homeDirectory)
    }), (result) => result.removed.length]
  ];
  const outcomes = [];
  for (const [id, heal, count] of healers) {
    try {
      const { result, receipt } = await heal();
      outcomes.push(Object.freeze({ id, outcome: count(result) ? 'healed' : 'clean', count: count(result), receipt }));
    } catch (error) {
      outcomes.push(Object.freeze({ id, outcome: 'failed', code: error?.code ?? 'WORKSPACE_HEALER_FAILED', reason: String(error?.message ?? error) }));
    }
  }
  return Object.freeze(outcomes);
}
