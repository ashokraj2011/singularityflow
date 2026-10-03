/**
 * The closed vocabulary of the evidence evaluator [E2G-028..030].
 *
 * Every view, refusal and label reads these values; none composes its own. A value that is not
 * listed here is a defect in the caller, so the helpers refuse it rather than pass it through.
 */

/** What a Story owes, independent of which step owes it. `complete` is the kernel's duty at an end. */
export const RESPONSIBILITIES = Object.freeze(['scope', 'plan', 'implement', 'verify', 'review', 'complete']);

/**
 * Assurance, weakest first. The identity rungs say how a test is tied to a criterion; the
 * execution rungs say how its run was observed. Nothing above `exact-local-observed` is reachable
 * before qualified execution exists, so it is listed but never produced here.
 */
export const ASSURANCE = Object.freeze([
  'none', 'declared', 'source-bound', 'module-observed', 'exact-local-observed', 'exact-authenticated'
]);

/**
 * The two facets assurance is made of [E2G-017], kept apart on every verify obligation. Identity:
 * how a witness is tied to its criterion — `declared` (a tag in a file) or `source-bound` (one
 * exact declaration whose revision is digested). Execution: how its run was observed — `none`,
 * `module-observed` (the covering module command passed), `exact-local-observed` (its own
 * occurrence was observed locally) or `exact-authenticated` (unreachable before qualified execution).
 */
export const IDENTITY_ASSURANCE = Object.freeze(['declared', 'source-bound']);
export const EXECUTION_ASSURANCE = Object.freeze(['none', 'module-observed', 'exact-local-observed', 'exact-authenticated']);

/**
 * The ladder rung a witness proved: its execution facet when it passed, otherwise only its identity.
 * An exact execution rung needs a source-bound identity; a declared identity caps at module-observed.
 */
export function combinedAssurance({ identity, execution, passed }) {
  if (!passed || execution === 'none') return IDENTITY_ASSURANCE.includes(identity) ? identity : 'none';
  if (identity !== 'source-bound' && ['exact-local-observed', 'exact-authenticated'].includes(execution)) return 'module-observed';
  return execution;
}

/** The six facets of one obligation, kept apart so no single word hides the others [E2G-029]. */
export const FACETS = Object.freeze(['coverage', 'execution', 'assurance', 'review', 'freshness', 'exception']);

/** One obligation's state. `excepted` means a governed exception carries it; the observation stays. */
export const OBLIGATION_STATUSES = Object.freeze([
  'met', 'partial', 'pending', 'missing', 'failed', 'inconclusive', 'excepted', 'not-applicable'
]);

/**
 * One row's result, from the strongest blocker down. `not-applicable` is a recorded applicability
 * decision: a scope disposition, so it never degrades a label.
 */
export const ROW_RESULTS = Object.freeze([
  'failed', 'inconclusive', 'missing', 'pending', 'satisfied-with-exception', 'satisfied', 'not-applicable'
]);

export const GATE_DECISIONS = Object.freeze(['allow', 'allow-with-risk', 'block']);

/** The default required assurance (D2): never below a passing module command. */
export const DEFAULT_REQUIRED_ASSURANCE = 'module-observed';

/** True when `actual` reaches `required` on the ladder. Unknown values never satisfy anything. */
export function assuranceAtLeast(actual, required) {
  const have = ASSURANCE.indexOf(actual);
  const need = ASSURANCE.indexOf(required);
  if (need < 0) throw new Error(`Unknown required assurance '${required}'.`);
  return have >= need;
}

/** The weakest assurance in a list, or `none` for an empty list. */
export function weakestAssurance(values) {
  const ranks = values.map((value) => ASSURANCE.indexOf(value)).filter((rank) => rank >= 0);
  return ranks.length ? ASSURANCE[Math.min(...ranks)] : 'none';
}

/**
 * A rename-stable obligation identity: the owning step is an attribute, never part of the ID, so a
 * consistent rename of every step leaves every obligation ID unchanged.
 */
export function obligationId(workId, responsibility, subject, slot = null) {
  if (!RESPONSIBILITIES.includes(responsibility)) throw new Error(`Unknown responsibility '${responsibility}'.`);
  const prefix = `${workId}:`;
  const local = String(subject).startsWith(prefix) ? String(subject).slice(prefix.length) : String(subject);
  return `OBL:${workId}:${responsibility}:${local}${slot ? `:${slot}` : ''}`;
}
