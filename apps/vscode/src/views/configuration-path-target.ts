/**
 * Which repository file the Configuration Center may open for a path it listed. Kept apart from the
 * Center's model so the activation bundle, which routes the open request, does not load the model's
 * YAML writers.
 */
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export type ConfigurationPathTarget =
  | { kind: 'artifact'; path: string }
  | { kind: 'unavailable'; message: string };

/** Open only a path the snapshot lists (templates, prompts and skills). */
export function configurationPathTarget(snapshot: RepositorySnapshot | null, requestedPath: string): ConfigurationPathTarget {
  const listed = new Set([
    ...(snapshot?.templates ?? []).map((entry) => entry.path),
    ...(snapshot?.prompts ?? snapshot?.agentPrompts ?? snapshot?.personaPrompts ?? []).map((entry) => entry.path),
    ...(snapshot?.repositorySkills ?? []).map((entry) => entry.path),
    ...(snapshot?.flowSkills ?? []).map((entry) => entry.packagePath ?? entry.path)
  ]);
  if (listed.has(requestedPath)) return { kind: 'artifact', path: requestedPath };
  return { kind: 'unavailable', message: `This repository no longer lists ${requestedPath}. Refresh and try again.` };
}
