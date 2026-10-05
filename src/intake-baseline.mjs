/** Pure intake decision. Deferring observation is not accepting failures or producing evidence. */
import { SingularityFlowError } from './util.mjs';

export function intakeBaselineChoice(value = 'reuse') {
  if (!['reuse', 'run', 'defer'].includes(value)) throw new SingularityFlowError(
    'Readiness baseline must be reuse, run, or defer.', { code: 'TEST_BASELINE_CHOICE_INVALID' });
  return value;
}

export function baselineChoiceAllowed(definition = {}, choice = 'reuse') {
  intakeBaselineChoice(choice);
  // Kept for callers of the intake contract. Legacy required-baseline policies do not make
  // tests an admission ticket. Their execution/evidence policy still applies at publication.
  return true;
}

export function requiredIntakePrerequisites(definition = {}) {
  const policies = [definition.repositoryReadiness, definition.initialization?.proof?.preStory].filter(Boolean);
  if (!policies.some(policy => policy.requiredBeforeStory === true)) return [];
  return [['dependencyHydration', 'dependency'], ['build', 'build'], ['applicationStart', 'start']]
    .filter(([field]) => policies.some(policy => policy[field] === 'required')).map(([, purpose]) => purpose);
}

/** Missing detection/observation is setup still to do, not a failing test run. */
export function baselineObservationPending(receipt = null) {
  if (!receipt) return true;
  // Never implicitly defer a failed execution, even when its report was unreadable.
  if (receipt.baselineSha256 || ['failing-tests', 'accepted-known-failures', 'readiness-failed'].includes(receipt.status)
      || (receipt.commandResults ?? []).some(entry => entry.purpose === 'test' && entry.status !== 'pass')
      || (receipt.testObservations ?? []).length) return false;
  return ['missing', 'stale', 'not-checked', 'no-commands-applicable'].includes(receipt.status)
    || receipt.structuredTestContract?.status !== 'available';
}

export function baselineDeferralAllowed(definition = {}, choice = 'reuse', receipt = null) {
  intakeBaselineChoice(choice);
  // All test outcomes are advisory at creation, including genuine failures. This does not
  // relabel them, accept their risk, or allow their evidence through a later phase gate.
  const requirements = requiredIntakePrerequisites(definition);
  if (!requirements.length) return true;
  if (!['pass', 'failing-tests', 'accepted-known-failures', 'readiness-failed'].includes(receipt?.status)
      || receipt.prerequisitesCurrent === false) return false;
  const passed = new Set((receipt?.commandResults ?? []).filter(entry => entry.status === 'pass')
    .map(entry => entry.purpose));
  return requirements.every(purpose => passed.has(purpose));
}
