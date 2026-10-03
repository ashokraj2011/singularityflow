/**
 * How each criterion witness stands against the run of its candidate [E2G-016, E2G-017].
 *
 * Pure, and safe for every surface. An exact witness (the Jest, Vitest or JUnit 5 declaration a
 * tag sits on) passes only through its own single occurrence in the authoritative attempt of its
 * command: the latest terminal attempt of the published candidate. A file-level witness (a module
 * whose adapter only counts tests) passes when that module command passed, and says so:
 * module-observed. Each witness must reach the strongest assurance its module's adapter can produce
 * (D2); a pass below it is an assurance shortfall, not a pass.
 */
import { ASSURANCE, EXECUTION_ASSURANCE, combinedAssurance } from '../evidence/vocabulary.mjs';
import { joinDeclaration } from './join.mjs';
import { profileCeiling, TEST_ADAPTER_PROFILES } from './profiles.mjs';

const OUTCOME_STATUS = Object.freeze({
  passed: 'met', flaky: 'inconclusive', failed: 'failed', 'unverified-skipped': 'missing',
  missing: 'missing', ambiguous: 'inconclusive', inconclusive: 'inconclusive',
  'passed-with-skips': 'inconclusive', unavailable: 'inconclusive', 'not-run': 'pending'
});

/** A short human name for a witness: the test's identity, or its file. */
export function witnessLabel(witness) {
  const identity = witness.identity ?? {};
  if (identity.className) return `${identity.className}#${identity.methodName}`;
  if (identity.name != null) return `'${[...(identity.suitePath ?? []), identity.name].join(' › ')}' in ${witness.testSource}`;
  return witness.testSource;
}

function declarationOf(witness) {
  const identity = witness.identity ?? {};
  return identity.className
    ? { className: identity.className, methodName: identity.methodName, parameters: witness.parameters ?? null, gaps: [] }
    : { sourcePath: witness.testSource, suitePath: identity.suitePath ?? [], name: identity.name, parameters: witness.parameters ?? null, gaps: [] };
}

function attemptRun(attempt) {
  return {
    completed: attempt.terminal !== false && attempt.timedOut !== true && !['blocked', 'unavailable'].includes(attempt.status),
    succeeded: attempt.status === 'passed' && (attempt.exitCode ?? 0) === 0 && Number(attempt.tests?.failed ?? 0) === 0
  };
}

/**
 * One witness's result. `attempt` is the authoritative attempt of the witness's command, or null
 * when none ran; `submitted` says whether the delivery reached submission (only then is an absent
 * result missing rather than pending).
 */
export function witnessResult(witness, attempt, { submitted = true } = {}) {
  const profile = witness.profile ?? 'module-counts-v1';
  const requiredAssurance = profileCeiling(profile);
  const base = {
    label: witnessLabel(witness), clauseId: witness.clauseId, testSource: witness.testSource, profile,
    commandId: witness.commandId ?? null, identityKey: witness.logicalTestId ?? null, requiredAssurance,
    attemptId: attempt?.attemptId ?? null
  };
  const finish = (result) => {
    const passed = result.status === 'met';
    const assurance = combinedAssurance({ identity: result.identity, execution: result.execution, passed });
    const shortfall = passed && ASSURANCE.indexOf(assurance) < ASSURANCE.indexOf(requiredAssurance);
    return { ...base, ...result, assurance, status: shortfall ? 'inconclusive' : result.status, shortfall };
  };
  if (!attempt) {
    return finish({
      outcome: 'not-run', status: submitted ? 'missing' : 'pending',
      identity: witness.identity && !(witness.gaps ?? []).length ? 'source-bound' : 'declared', execution: 'none', reasons: ['NO_ATTEMPT']
    });
  }
  const run = attemptRun(attempt);
  if (!witness.identity) {
    const skipped = Number(attempt.tests?.skipped ?? 0);
    const outcome = !run.completed ? 'unavailable' : !run.succeeded ? 'failed' : skipped > 0 ? 'passed-with-skips' : 'passed';
    return finish({ outcome, status: OUTCOME_STATUS[outcome], identity: 'declared', execution: run.succeeded ? 'module-observed' : 'none', skipped, reasons: [] });
  }
  if ((witness.gaps ?? []).length) {
    return finish({ outcome: 'inconclusive', status: 'inconclusive', identity: 'declared', execution: run.succeeded ? 'module-observed' : 'none', reasons: [...witness.gaps] });
  }
  const adapter = TEST_ADAPTER_PROFILES[profile] ?? {};
  let joined = joinDeclaration(declarationOf(witness), attempt.occurrences ?? [], { language: adapter.language, runner: adapter.runner ?? null, run });
  // A run that failed or ended without a result for this test proves nothing about it either way.
  if (joined.outcome === 'missing' && !run.succeeded) {
    joined = { outcome: run.completed ? 'failed' : 'unavailable', reasons: ['RUN_FAILED_WITHOUT_RESULT'], occurrences: [] };
  }
  // Exact execution was observed only when this test's own occurrence was found and judged.
  const observed = (joined.occurrences ?? []).length > 0 && ['passed', 'flaky', 'failed', 'unverified-skipped'].includes(joined.outcome);
  return finish({
    outcome: joined.outcome, status: OUTCOME_STATUS[joined.outcome] ?? 'inconclusive', identity: 'source-bound',
    execution: observed ? 'exact-local-observed' : run.succeeded ? 'module-observed' : 'none',
    reasons: joined.reasons ?? [], occurrences: joined.occurrences ?? []
  });
}

/**
 * A criterion's witnesses under an `all` contract: every witness must pass at its required
 * assurance; the strongest blocker wins; the rung is the weakest any witness reached. An empty
 * witness set never passes.
 */
export function aggregateWitnesses(results) {
  if (!results.length) return { status: 'missing', assurance: 'none', identity: 'none', execution: 'none' };
  const statuses = results.map((entry) => entry.status);
  const weaker = (list, left, right) => (list.indexOf(left) <= list.indexOf(right) ? left : right);
  return {
    status: ['failed', 'inconclusive', 'missing', 'pending'].find((value) => statuses.includes(value)) ?? 'met',
    assurance: results.map((entry) => entry.assurance).reduce((left, right) => weaker(ASSURANCE, left, right)),
    identity: results.some((entry) => entry.identity === 'declared') ? 'declared' : 'source-bound',
    execution: results.map((entry) => entry.execution).reduce((left, right) => weaker(EXECUTION_ASSURANCE, left, right))
  };
}

const OUTCOME_WORDS = Object.freeze({
  passed: 'passed', flaky: 'passed only after failing in the same run, which is not a pass', failed: 'failed',
  'unverified-skipped': 'was skipped, so it verified nothing', missing: 'has no result in the run of its candidate',
  ambiguous: 'matches more than one result, so none can be credited', inconclusive: 'cannot be tied to one exact result',
  'passed-with-skips': 'passed with skipped tests in its module', unavailable: 'produced no usable result', 'not-run': 'has not run yet'
});

/** One witness result in words, for review and submission surfaces; the evaluator stays the authority. */
export function describeWitnessResult(result) {
  const subject = result.identityKey ? result.label : `the test command covering ${result.testSource}`;
  const reasons = result.outcome === 'inconclusive' && result.reasons?.length ? ` (${result.reasons.join(', ')})` : '';
  const shortfall = result.shortfall ? `; it reached ${result.assurance}, below the ${result.requiredAssurance} its runner can reach` : '';
  return `${subject} ${OUTCOME_WORDS[result.outcome] ?? result.outcome}${reasons}${shortfall}`;
}

/** Witness results grouped by criterion, each with the `all` aggregate of its witnesses. */
export function criterionResults(results) {
  const byClause = new Map();
  for (const result of results) byClause.set(result.clauseId, [...(byClause.get(result.clauseId) ?? []), result]);
  return [...byClause.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([clauseId, entries]) => ({ clauseId, ...aggregateWitnesses(entries), witnesses: entries }));
}
