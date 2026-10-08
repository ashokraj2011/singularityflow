import { VIEW_ID_PATTERN } from '../contracts.mjs';

const COMPOSITION_CODES = new Set([
  'WMB_FACT_REFERENCE_UNKNOWN', 'WMB_FACT_ASSURANCE_UPGRADED', 'WMB_MODEL_OUTPUT_INVALID',
  'WMB_SECTION_MISSING', 'WMB_SECTION_UNREGISTERED', 'WMB_SECTION_ORDER_INVALID'
]);

/** Producer-owned guidance for an invalid model candidate, without leaking its source prose. */
export function worldModelCompositionRecovery(refusal) {
  const failure = refusal?.failures?.find((entry) => COMPOSITION_CODES.has(entry?.code));
  const view = refusal?.view;
  if (!failure || typeof view !== 'string' || !VIEW_ID_PATTERN.test(view)) return null;
  return Object.freeze({
    actions: Object.freeze([
      {
        command: `singularity-flow wm view-contract ${view} --format registered-v4 --json`,
        label: `Inspect the exact '${view}' view contract and fact-reference rules. This is a composition failure, not a missing repository or configuration.`
      },
      {
        label: `In World Model → Build / refresh, keep the Model composer, retain the reviewed scope and view selections, and review a fresh exact Plan after updating SFlow. Citation-only layout is repaired locally without another model call; unknown facts, changed canonical claims, missing mandatory facts and integrity failures remain refused. Do not edit generated facts, weaken validation, or loop on the unchanged failure.`
      }
    ])
  });
}
