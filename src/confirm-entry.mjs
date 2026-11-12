/**
 * `singularity-flow confirm <CODE>`: the command a short confirmation code stands for, run as if typed
 * (confirm-code.mjs). The entry swaps the two words for that command before anything else reads them, so
 * its output, refusals, agent view and kept result are that command's own; a stale digest is still refused
 * by the command itself. Only `--json`, `--for-agent` and `--no-model` may come with it: the code names everything else.
 */
import { resolveConfirmCode, normalizeConfirmCode } from './confirm-code.mjs';
import { parseArgs, SingularityFlowError } from './util.mjs';
import { validateSflowExecutionCommand } from './safe-command-guidance.mjs';

const KEPT_OPTIONS = new Set(['json', 'for-agent', 'model']);

/** The argv `confirm <CODE>` stands for (the code's command, then the caller's --json/--for-agent), or a refusal. */
export function expandConfirmArgv(argv, { env = process.env } = {}) {
  const { positionals, options } = parseArgs(argv);
  const extra = Object.keys(options).filter((key) => !KEPT_OPTIONS.has(key) || (key === 'model' && options.model !== false));
  const typed = positionals[1] ?? '';
  if (positionals.length !== 2 || extra.length || !normalizeConfirmCode(typed)) {
    throw new SingularityFlowError('Use singularity-flow confirm <CODE> with the eight-character code a preview gave (like K7Q2-M8DX), and at most --json or --for-agent.',
      { code: 'CONFIRM_CODE_USAGE', details: { nextAction: 'singularity-flow nextsteps --json' } });
  }
  const found = resolveConfirmCode(typed, { env });
  const safe = found ? validateSflowExecutionCommand(found.command, { shell: 'posix' }) : null;
  if (!found || !safe?.argv?.length || safe.argv[0] === 'confirm') {
    throw new SingularityFlowError(`No confirmation is waiting under ${normalizeConfirmCode(typed)} on this machine: it was given elsewhere, or more than a week ago. `
      + 'Nothing was changed. Preview the action again; its route carries the current code.',
      { code: 'CONFIRM_CODE_UNKNOWN', details: { nextAction: 'singularity-flow nextsteps --json' } });
  }
  return [...(options.model === false ? ['--no-model'] : []), ...safe.argv,
    ...(options.json !== undefined ? ['--json'] : []), ...(options['for-agent'] !== undefined ? ['--for-agent'] : [])];
}
