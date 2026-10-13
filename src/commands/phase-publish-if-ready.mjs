/**
 * `phase prepublish <PHASE> --for-agent --json --publish-if-ready`: the end of every drafting skill
 * in one command.
 *
 * Twelve skills ended with three commands in a row: prepublish, then the returned
 * `commands.publish` when it was ready, then `phase show` to report the publication. Each was its own
 * Copilot round trip, and only the first one needed the model's judgment (correcting findings).
 * This runs the same three. The output is the prepublish result unchanged, so every field a skill
 * reads stays where it was, plus `publishIfReady` with what happened after it. Publication runs only
 * when prepublish itself offered the exact command; a refused step keeps its own refusal.
 */
import { step, stop } from '../cli-steps.mjs';
import { SingularityFlowError } from '../util.mjs';

const PRODUCERS = new Set(['human', 'governed-agent', 'deterministic', 'external-tool']);
const CHANNELS = new Set(['manual-in-place', 'copilot-host', 'kernel-model', 'kernel-generator', 'external-tool']);

/** The returned publication command as arguments, or null when it is not one this runs as-is. */
export function publicationArguments(command, phaseId) {
  const tokens = String(command ?? '').split(' ');
  const [executable, noun, verb, phase, ...flags] = tokens;
  if (executable !== 'singularity-flow' || noun !== 'phase' || verb !== 'publish' || phase !== phaseId) return null;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--no-model') continue;
    const value = flags[index + 1];
    if (flag === '--authored' && PRODUCERS.has(value)) { index += 1; continue; }
    if (flag === '--channel' && CHANNELS.has(value)) { index += 1; continue; }
    return null;
  }
  return tokens.slice(1);
}

export async function run({ positionals, options }) {
  if (options['for-agent'] !== true || options.json !== true) {
    throw new SingularityFlowError('--publish-if-ready requires --for-agent --json.', { code: 'PHASE_PUBLISH_IF_READY_OPTIONS' });
  }
  const cwd = process.cwd();
  const requested = positionals[2] ?? null;
  const checked = await step(['phase', 'prepublish', ...(requested ? [requested] : []), '--for-agent', '--json'], cwd);
  if (!checked.ok) stop(checked, 'phase prepublish');
  const prepublish = checked.value;
  const phaseId = prepublish.phase ?? requested;
  const argv = prepublish.status === 'ready' ? publicationArguments(prepublish.commands?.publish, phaseId) : null;
  if (!argv) {
    return console.log(JSON.stringify({ ...prepublish, publishIfReady: {
      published: false,
      reason: prepublish.status !== 'ready' ? 'not-ready' : prepublish.commands?.publish ? 'publish-command-not-recognized' : 'no-publish-command',
      command: prepublish.commands?.publish ?? null
    } }));
  }
  const published = await step([...argv, '--json'], cwd);
  if (!published.ok) stop(published, 'phase publish');
  const shown = await step(['phase', 'show', phaseId, '--for-agent', '--json'], cwd);
  if (!shown.ok) stop(shown, 'phase show');
  console.log(JSON.stringify({ ...prepublish, publishIfReady: {
    published: true, command: prepublish.commands.publish,
    output: published.stdout.trim().split('\n').slice(-40).join('\n'),
    review: shown.value
  } }));
}
