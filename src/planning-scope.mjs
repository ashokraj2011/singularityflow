/**
 * Constants shared by the engine and the desktop renderer.
 *
 * These live apart from planning.mjs because that module imports node:crypto and the filesystem,
 * which cannot be bundled into the Electron renderer. Duplicating the values instead would create
 * the second source of truth that the promotion fence and the action vocabulary have each already
 * drifted into once.
 */

/** Target id meaning "every promotable output of this phase, from one conversation". */
export const PHASE_SCOPE = '*';

/** The fence promotion parses. Only content between these markers is ever written. */
export function artifactBlockMarkers(outputId) {
  return { start: `<<<SFLOW-ARTIFACT:${outputId}`, end: `SFLOW-ARTIFACT:${outputId}>>>` };
}
