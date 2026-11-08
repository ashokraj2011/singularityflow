export { normalizeDocumentObligations } from "./engine-compatibility/node-configuration-path.mjs";
/** Explicit supplemental document obligations; never essential workflow/policy artifacts. */

export function documentObligationsForPhase(workflow, phaseId) {
  if (workflow.resolution?.testRecovery?.enabled !== true) return [];
  return (workflow.resolution.testRecovery.documentObligations ?? []).filter(entry => entry.phaseId === phaseId);
}
