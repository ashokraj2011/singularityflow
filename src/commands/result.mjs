/**
 * `singularity-flow result last [--wait [SECONDS]] [--command WORDS] [--json]`: the newest result an
 * agent command kept in this checkout (src/agent-result-keeper.mjs), whole, after waiting for any
 * command of the checkout still running. A read: it runs nothing again, so an agent whose host cut a
 * result off, or returned while the command still ran, gets that result instead of rerunning it.
 */
import { lastAgentResult, RESULT_WAIT_DEFAULT_SECONDS, RESULT_WAIT_MAXIMUM_SECONDS } from '../agent-result-keeper.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const OPTIONS = new Set(['wait', 'command', 'json', 'timings']);
export const RESULT_LAST_COMMAND = 'singularity-flow result last --wait --for-agent --json';

function fail(message) {
  throw new SingularityFlowError(`${message} Use: singularity-flow result last [--wait [SECONDS]] [--command WORDS] [--json].`, { code: 'RESULT_COMMAND_INVALID' });
}

function waitSeconds(value) {
  if (value === undefined || value === false) return 0;
  if (value === true || value === 'true') return RESULT_WAIT_DEFAULT_SECONDS;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > RESULT_WAIT_MAXIMUM_SECONDS) fail(`--wait is a whole number of seconds from 0 to ${RESULT_WAIT_MAXIMUM_SECONDS}.`);
  return seconds;
}

/** What `result last` returns: the kept result itself, marked as kept, or why there is none. */
export function keptResultView(found, { command = null } = {}) {
  if (found.status === 'kept') {
    const meta = { command: found.kept.command, startedAt: found.kept.startedAt, finishedAt: found.kept.finishedAt, others: found.others };
    let value = null;
    try { value = JSON.parse(found.kept.output); } catch { /* A text result is returned as text. */ }
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, keptResult: meta }
      : { schemaVersion: 1, resultType: 'sflow-kept-result', status: 'kept-text', keptResult: meta, text: found.kept.output };
  }
  return { schemaVersion: 1, resultType: 'sflow-kept-result', status: found.status,
    ...(found.running ? { running: found.running } : {}), ...(found.interrupted ? { interrupted: found.interrupted } : {}),
    ...(found.status === 'running' ? { retry: retryFor(command) } : {}),
    ...(found.status === 'none' && command ? { command, ...(safeReadFor(command) ? { safeRead: safeReadFor(command) } : {}) } : {}) };
}

// The same read again for the same command: without its words, another command's result could answer.
const retryFor = (command) => (command && /^[A-Za-z0-9][A-Za-z0-9 ._:-]*$/u.test(String(command).trim())
  ? `singularity-flow result last --wait --command "${String(command).trim()}" --for-agent --json` : RESULT_LAST_COMMAND);

/**
 * The read that says where a command left things, for one whose result was not kept, so nothing runs it again:
 * a review's own status (retained or not, and what comes next), else the Story's next steps. Null without a command.
 */
export function safeReadFor(command) {
  const words = String(command ?? '').trim().replace(/^(?:singularity-flow|sflow)\s+/u, '').split(/\s+/u).filter(Boolean);
  if (!words.length) return null;
  if (words[0] === 'review-source' && words[1]) {
    const phase = words[2] && !words[2].startsWith('-') ? ` ${words[2]}` : '';
    return `singularity-flow review-source status${phase} --for-agent --json`;
  }
  if (words[0] === 'session') return 'singularity-flow session current --for-agent --json';
  return 'singularity-flow nextsteps --for-agent --json';
}

export async function run(_argv, { positionals, options = {} }) {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.has(key)).sort();
  if (unknown.length) fail(`result does not accept ${unknown.map((key) => `--${key}`).join(', ')}.`);
  if (positionals[1] !== 'last' || positionals.length > 2) fail('The only result read is `result last`.');
  // The folder the command was run from, as its results were filed, not a Story checkout it moved to.
  const found = await lastAgentResult({ cwd: globalThis.__SFLOW_INVOCATION_CWD ?? process.cwd(),
    wait: waitSeconds(options.wait), command: optionString(options, 'command', null) });
  const view = keptResultView(found, { command: optionString(options, 'command', null) });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(view, null, 2));
  if (found.status === 'kept') {
    console.log(`Newest result kept for this checkout: ${found.kept.command} (finished ${found.kept.finishedAt}).`);
    return console.log(found.kept.output.trimEnd());
  }
  console.log(found.status === 'running' ? `Still running: ${found.running.map((entry) => entry.command).join('; ')}. Run this read again; never run the command again.`
    : found.status === 'interrupted' ? `${found.interrupted.command} ended without a result (interrupted or killed). Run it again once.`
      : 'No result is kept for this checkout.');
}
