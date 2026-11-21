/**
 * The intent of each step SFlow ships (templates/workflow.yml), by step ID (step intents spec §4.3 and Appendix B). A
 * step that is an exact shipped revision (packaged-workflow-history.mjs) has this intent for certain. Import-free, so
 * seeded-workflow protection reads it without loading the profiles; step-intents.mjs re-exports it.
 */
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const PACKAGED_STEP_INTENTS = deepFreeze({
  intake: 'intake', requirements: 'requirements', design: 'design', 'implementation-spec': 'plan', implementation: 'code',
  verification: 'test', conformance: 'review',
  reproduction: 'design', 'fix-design': 'design', 'fix-spec': 'plan',
  'findings-intake': 'requirements', 'remediation-plan': 'plan',
  'design-intake': 'intake', 'design-inventory': 'design', 'component-mapping': 'design', 'mobile-spec': 'plan', 'visual-verification': 'test',
  implement: 'code', verify: 'test',
  'careful-change': 'code', 'test-run': 'test', testing: 'test', specification: 'requirements',
  'document-intake': 'intake', 'scenario-check': 'test', 'scenario-repair': 'code', 'scenario-retest': 'test',
  'demo-web-intake': 'intake', 'demo-web-check': 'test', 'demo-web-repair': 'code', 'demo-web-retest': 'test',
  'demo-intake': 'intake', 'demo-check': 'test', 'demo-repair': 'code', 'demo-close': 'report',
  'demo-instruction-intake': 'intake', 'demo-instruction-test': 'test', 'demo-instruction-repair': 'code', 'demo-instruction-close': 'report',
  'poc-lite-plan': 'plan', 'poc-lite-act': 'code', 'poc-lite-verify': 'test', 'poc-lite-finalize': 'release',
  'poc-intake': 'intake', 'poc-impact-analysis': 'design', 'poc-ui-exploration': 'design', 'poc-test-generation': 'code',
  'poc-validation': 'test', 'poc-publication-review': 'release',
  planning: 'plan', convergence: 'review', release: 'review'
});
