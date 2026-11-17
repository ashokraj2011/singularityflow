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

/**
 * What `submit` says it did: its commit, push and packet come first in what it prints, and its last
 * lines give next steps for the state before the holds were read. `next` is the next step, `review` the documents.
 * Read only when `submit --json` gave no result object.
 */
export function submitReport(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim());
  const did = lines.filter((line) => /^(?:Commit|Committed|Push|Review packet): |^(?:Submitted|Completed) /u.test(line));
  return did.length ? did.join('\n') : lines.filter(Boolean).slice(-40).join('\n');
}

/**
 * What `submit --json` says it did, in the facts its text names: the step and its version, whether the
 * submission completed the step, and where it was pushed. Never its commit or packet digest: an agent relays this.
 */
export function submittedResult(value) {
  const data = value?.data ?? {};
  const messageId = value?.outcome?.messageId;
  return {
    phase: value?.outcome?.slots?.phase ?? null,
    generation: data.generation ?? null,
    status: messageId === 'submit.completed' ? 'completed' : messageId === 'submit.noop' ? 'already-submitted' : 'submitted',
    committed: typeof data.commit === 'string',
    pushedTo: data.pushedTo ?? null
  };
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
  const show = (...phase) => step(['phase', 'show', ...phase, '--for-agent', '--json'], cwd);
  const shown = await show(readiness.phaseId);
  if (!shown.ok) stop(shown, 'phase show');
  const result = submitted.value?.operation?.id === 'submit' ? submittedResult(submitted.value) : submitReport(submitted.stdout);
  // A step its submission completed (nobody approves it) is behind the Story now: what follows is the step that is current,
  // as every view names it, never a hand-off to next steps (journey Q, 2026-11-17). A Story that ended keeps the step's own.
  const following = result?.status === 'completed' ? await show() : null;
  // First, with what follows: the readiness fields after it describe the step before submission.
  console.log(JSON.stringify({ submitIfReady: {
    submitted: true, next: nextAfterStep(following?.ok && following.value?.continuation ? following.value : shown.value, 'Submitted.'), command: readiness.nextCommand,
    result, review: shown.value
  }, ...readiness }, null, 2));
}
