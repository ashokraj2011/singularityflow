/**
 * The closed set of rules under which earlier evidence or an earlier approval may be reused
 * [E2G-021, decisions D8 and D16].
 *
 * Reuse without a rule is staleness. The set is owned by the product: a workflow cannot add a rule,
 * because an authored rule would be a waiver by another name. Each rule says what it permits and
 * which part of the product applies it, and a record that relies on one names it. Pure.
 */
import { SingularityFlowError } from '../util.mjs';

export const EQUIVALENCE_RULES = Object.freeze({
  E1: Object.freeze({
    name: 'identical inputs',
    permits: 'an approval stays valid when everything it decided over is byte-identical: the phases it declares as inputs, the code candidate, the specification records, the documents offered to it, the Story decisions and its own artifacts',
    appliedBy: 'rework (src/phase-retention.mjs)'
  }),
  E2: Object.freeze({
    name: 'documentation only',
    permits: 'top-level project notes (README, CHANGELOG, CONTRIBUTING, LICENSE, NOTICE) never count as product source',
    appliedBy: 'code delivery (src/delivery-evidence.mjs)'
  }),
  E3: Object.freeze({
    name: 'test-only repair',
    permits: 'a repair during testing that changes only test automation keeps the implementation evidence',
    appliedBy: 'testing repair (previewTestingRepair in src/state.mjs)'
  }),
  E4: Object.freeze({
    name: 'test command epoch',
    permits: 'an accepted test-command change revalidates evidence without regenerating it',
    appliedBy: 'src/test-command-epoch.mjs'
  }),
  E5: Object.freeze({
    name: 'unaffected skill package',
    permits: 'a skill-version amendment keeps the approval of phases with no route to the changed skill',
    appliedBy: 'src/skp-amendment-plan.mjs'
  }),
  E6: Object.freeze({
    name: 'unlinked clause change',
    permits: 'a scope revision leaves the evidence of clauses it did not change fresh',
    appliedBy: 'src/scope/revisions.mjs'
  }),
  E7: Object.freeze({
    name: 'baseline-mutable roots',
    permits: 'paths a declared test run may rewrite do not count as a change to the baseline',
    appliedBy: 'test recovery (src/test-recovery-runtime.mjs)'
  })
});

/** The rule, or a refusal: nothing outside the product's set authorizes reuse. */
export function equivalenceRule(id) {
  const rule = Object.hasOwn(EQUIVALENCE_RULES, id) ? EQUIVALENCE_RULES[id] : null;
  if (!rule) {
    throw new SingularityFlowError(`Evidence is reused only under a product rule (${Object.keys(EQUIVALENCE_RULES).join(', ')}); '${id}' is not one.`, {
      code: 'EQUIVALENCE_RULE_UNKNOWN', details: { rule: id ?? null }
    });
  }
  return rule;
}

/** What a record that relies on a rule carries. */
export function retainedByRule(id, details = {}) {
  equivalenceRule(id);
  return { rule: id, ...details };
}
