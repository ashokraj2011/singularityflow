/** Native human wording; all identity and verdict rules have one shared kernel owner. */
export {witnessLabel,witnessResult,aggregateWitnesses,criterionResults} from '../kernel/verification-witnesses.mjs';
const OUTCOME_WORDS = Object.freeze({
  passed: 'passed', flaky: 'passed only after failing in the same run, which is not a pass', failed: 'failed',
  'unverified-skipped': 'was skipped, so it verified nothing', missing: 'has no result in the run of its candidate',
  ambiguous: 'matches more than one result, so none can be credited', inconclusive: 'cannot be tied to one exact result',
  'passed-with-skips': 'passed with skipped tests in its module', unavailable: 'produced no usable result', 'not-run': 'has not run yet'
});
export function describeWitnessResult(result) {
  const subject = result.identityKey ? result.label : `the test command covering ${result.testSource}`;
  const reasons = result.outcome === 'inconclusive' && result.reasons?.length ? ` (${result.reasons.join(', ')})` : '';
  const shortfall = result.shortfall ? `; it reached ${result.assurance}, below the ${result.requiredAssurance} its runner can reach` : '';
  return `${subject} ${OUTCOME_WORDS[result.outcome] ?? result.outcome}${reasons}${shortfall}`;
}
