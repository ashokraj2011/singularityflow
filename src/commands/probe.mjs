/**
 * `singularity-flow probe office [--json] [--out FILE]`: the office checks (src/office-probe/), one scrubbed report
 * a person sends back. Loaded only by this command.
 *
 * Questions are asked where the person is: in a terminal one line each (Enter is No); from VS Code
 * (`--host-questions`) as `SFLOW_PROBE_ASK` lines VS Code answers with buttons; otherwise `--push`, `--chat` and
 * `--intellij` answer Yes (`--no-push` and the like No), `--jira KEY` gives the key, and every other question is No. Ctrl+C stops after the current step
 * and still writes the report; a second Ctrl+C leaves at once.
 */
import readline from 'node:readline';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const OPTIONS = new Set(['json', 'out', 'host-questions', 'push', 'chat', 'intellij', 'jira', 'timings']);
const FLAG_FOR = { push: 'push', 'vscode-chat': 'chat', 'intellij-chat': 'intellij' };

function fail(message, code = 'PROBE_OPTIONS_INVALID') {
  throw new SingularityFlowError(message, { code, details: { nextAction: { command: 'singularity-flow probe office', label: 'Run the office checks' } } });
}

function yesNo(value, name) {
  if (value == null) return null;
  if (value === true || value === false) return value;
  const text = String(value).trim().toLowerCase();
  if (['yes', 'y', 'true'].includes(text)) return true;
  if (['no', 'n', 'false'].includes(text)) return false;
  return fail(`--${name} takes yes or no.`);
}

/** Lines from VS Code: answers, in order, and `cancel` at any time. */
function hostChannel() {
  const waiting = [];
  const queued = [];
  let cancelled = false;
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim().toLowerCase() === 'cancel') { cancelled = true; while (waiting.length) waiting.shift()(null); return; }
    if (waiting.length) waiting.shift()(line); else queued.push(line);
  });
  lines.on('close', () => { while (waiting.length) waiting.shift()(null); });
  const next = () => (queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiting.push(resolve)));
  const send = (kind, value) => process.stdout.write(`SFLOW_PROBE_${kind} ${JSON.stringify(value)}\n`);
  return {
    cancelled: () => cancelled,
    note: (text, detail = {}) => send('NOTE', { text, ...detail }),
    ask: async (question) => { send('ASK', { ...question, kind: 'yes-no' }); return /^y(?:es)?$/iu.test(String(await next() ?? '').trim()); },
    askText: async (question) => { send('ASK', { ...question, kind: 'text' }); return String(await next() ?? '').trim() || null; },
    done: (value) => send('DONE', value),
    close: () => lines.close()
  };
}

function terminalChannel(state) {
  const ask = (prompt) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.on('SIGINT', () => { state.stop(); rl.close(); resolve(''); });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
  return {
    note: (text) => process.stderr.write(`  ${text}\n`),
    ask: async ({ question, why, yes, no }) => {
      process.stderr.write(`\n${question}\n  Why: ${why}\n  ${yes}\n  ${no}\n`);
      return /^y(?:es)?$/iu.test(String(await ask('Yes or No? [y/N] ')).trim());
    },
    askText: async ({ question, why }) => {
      process.stderr.write(`\n${question}\n  Why: ${why}\n`);
      return String(await ask('Issue key (Enter to skip): ')).trim() || null;
    }
  };
}

function flagChannel(options) {
  const answers = Object.fromEntries(['push', 'chat', 'intellij'].map((name) => [name, yesNo(options[name], name)]));
  const jira = typeof options.jira === 'string' ? options.jira : null;
  return {
    note: optionBoolean(options, 'json') ? () => {} : (text) => process.stderr.write(`  ${text}\n`),
    ask: async ({ id }) => answers[FLAG_FOR[id]] === true,
    askText: async () => jira ?? null
  };
}

export async function probeCommand(positionals, options = {}, { cwd = process.cwd(), env = process.env } = {}) {
  const subcommand = positionals[1];
  if (subcommand !== 'office') fail(subcommand ? `Unknown probe '${subcommand}'. The one probe is: office.` : 'Say which probe to run: singularity-flow probe office.', 'UNKNOWN_SUBCOMMAND');
  if (positionals.length > 2) fail('probe office takes no other words.');
  const unknown = Object.keys(options).filter((key) => !OPTIONS.has(key));
  if (unknown.length) fail(`probe office does not accept ${unknown.map((key) => `--${key}`).join(', ')}.`);
  for (const name of ['push', 'chat', 'intellij']) yesNo(options[name], name);
  let stopped = false;
  let interrupts = 0;
  const state = { stop: () => { stopped = true; } };
  const onSignal = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    stopped = true;
    process.stderr.write('\nStopping after this step; anything pushed is deleted and the report is still written. Ctrl+C again leaves at once.\n');
  };
  process.on('SIGINT', onSignal);
  const host = optionBoolean(options, 'host-questions') ? hostChannel() : null;
  const flagged = ['push', 'chat', 'intellij', 'jira'].some((name) => options[name] != null);
  const channel = host ?? (!flagged && process.stdin.isTTY && process.stderr.isTTY ? terminalChannel(state) : flagChannel(options));
  const { runOfficeChecks } = await import('../office-probe/index.mjs');
  try {
    const { files, report } = await runOfficeChecks({
      cwd, env, out: optionString(options, 'out'), surface: host ? 'vscode' : 'cli',
      ask: channel.ask, askText: channel.askText, note: channel.note,
      cancelled: () => stopped || Boolean(host?.cancelled())
    });
    host?.done({ markdown: files.markdown, json: files.json, counts: report.counts });
    return { schemaVersion: 1, resultType: 'sflow-office-checks', files, report,
      words: `Report written: ${files.markdown} (and ${files.json} beside it). Send this file back.` };
  } finally {
    process.removeListener('SIGINT', onSignal);
    host?.close();
  }
}

export async function run(_argv, { positionals = [], options = {} } = {}) {
  const result = await probeCommand(positionals, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else if (!optionBoolean(options, 'host-questions')) {
    const { pass = 0, fail: failed = 0 } = result.report.counts;
    console.log(`\n${pass} passed, ${failed} failed, ${result.report.counts['not available']} not available.`);
    console.log(result.words);
  }
  return result;
}
