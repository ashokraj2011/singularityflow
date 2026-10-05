/** Pure intake decision. Deferring observation is not accepting failures or producing evidence. */
import { SingularityFlowError } from './util.mjs';

export function intakeBaselineChoice(value = 'reuse') {
  if (!['reuse', 'run', 'defer'].includes(value)) throw new SingularityFlowError(
    'Readiness baseline must be reuse, run, or defer.', { code: 'TEST_BASELINE_CHOICE_INVALID' });
  return value;
}

export function baselineChoiceAllowed(definition = {}, choice = 'reuse') {
  intakeBaselineChoice(choice);
  return choice !== 'defer' || ((definition.repositoryReadiness?.baselinePolicy ?? 'choice') === 'choice'
    && definition.initialization?.proof?.preStory?.requiredBeforeStory !== true);
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
  if (!baselineChoiceAllowed(definition, 'defer')
      || (choice !== 'defer' && !(choice === 'reuse' && baselineObservationPending(receipt)))) return false;
  if (definition.repositoryReadiness?.requiredBeforeStory !== true
      && definition.initialization?.proof?.preStory?.requiredBeforeStory !== true) return true;
  // Choice only defers test observation, never a required dependency/build/start prerequisite.
  const requirements = [['dependencyHydration', 'dependency'], ['build', 'build'], ['applicationStart', 'start']]
    .filter(([field]) => definition.repositoryReadiness?.[field] === 'required'
      || definition.initialization?.proof?.preStory?.[field] === 'required');
  if (!requirements.length) return true;
  if (!['pass', 'failing-tests', 'accepted-known-failures', 'readiness-failed'].includes(receipt?.status)
      || receipt.prerequisitesCurrent === false) return false;
  const passed = new Set((receipt?.commandResults ?? []).filter(entry => entry.status === 'pass')
    .map(entry => entry.purpose));
  return requirements.every(([, purpose]) => passed.has(purpose));
}
