/**
 * `status <WORK-ID> --submission-readiness --json --submit-if-ready`: `/sf-submit`'s ready path in
 * one command.
 *
 * The skill ran readiness, then the returned Work-ID-pinned submit command, then `phase show` to
 * report what was submitted: three Copilot round trips, none of which needed the model when
 * readiness said `ready-to-attempt` with nothing to confirm. This runs the same three. The output is
 * the readiness result unchanged plus `submitIfReady`. Anything a person decides (a confirmation, a
 * convergence digest, a source review, an amendment choice) is never `ready-to-attempt` without
 * confirmation, so it is returned unrun, exactly as before; a refused step keeps its own refusal.
 */
import { nextAfterStep, step, stop } from '../cli-steps.mjs';
import { SingularityFlowError } from '../util.mjs';

/** The returned submit command as arguments, only when it is exactly the readiness route. */
export function submitArguments(readiness) {
  if (readiness?.classification !== 'ready-to-attempt' || readiness.lifecycleReady !== true
    || readiness.confirmationRequired !== false || readiness.nextSkill !== '/sf-submit') return null;
  const { phaseId, workId } = readiness;
  if (typeof phaseId !== 'string' || typeof workId !== 'string') return null;
  return readiness.nextCommand === `singularity-flow submit ${phaseId} --work-id ${workId}`
    ? ['submit', phaseId, '--work-id', workId] : null;
}

function notSubmittedReason(readiness) {
  if (readiness?.confirmationRequired) return 'confirmation-required';
  if (readiness?.classification !== 'ready-to-attempt') return readiness?.classification ?? 'not-ready';
  return 'route-not-recognized';
}

export async function run({ positionals, options }) {
  if (options.json !== true) {
    throw new SingularityFlowError('--submit-if-ready requires --submission-readiness --json.', { code: 'SUBMIT_IF_READY_OPTIONS' });
  }
  const cwd = process.cwd();
  const workId = positionals[1] ?? null;
  const checked = await step(['status', ...(workId ? [workId] : []), '--submission-readiness', '--json'], cwd);
  if (!checked.ok) stop(checked, 'status --submission-readiness');
  const readiness = checked.value;
  const argv = submitArguments(readiness);
  if (!argv) {
    return console.log(JSON.stringify({ ...readiness, submitIfReady: {
      submitted: false, reason: notSubmittedReason(readiness), command: readiness?.nextCommand ?? null
    } }, null, 2));
  }
  const submitted = await step([...argv, '--json'], cwd);
  if (!submitted.ok) stop(submitted, 'submit');
  const shown = await step(['phase', 'show', readiness.phaseId, '--for-agent', '--json'], cwd);
  if (!shown.ok) stop(shown, 'phase show');
  // First, with what follows: the readiness fields after it describe the step before submission.
  console.log(JSON.stringify({ submitIfReady: {
    submitted: true, next: nextAfterStep(shown.value, 'Submitted.'), command: readiness.nextCommand,
    result: submitted.value ?? submitted.stdout.trim().split('\n').slice(-40).join('\n'),
    review: shown.value
  }, ...readiness }, null, 2));
}
