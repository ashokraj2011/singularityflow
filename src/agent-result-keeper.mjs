/**
 * The newest agent results of a checkout, kept so an agent whose host cut a result off, or returned
 * while the command was still running, reads it whole instead of guessing. `[result-recovery]`
 *
 * Office, 2026-10-27: /sf-code ran `phase prepublish`, which runs the tests. VS Code's terminal tool
 * returned only part of its output, so the agent never saw which requirements still lacked a test;
 * it ran another read, changed nothing and pointed back to /sf-code. Running prepublish again was no
 * answer either: it runs the tests again and rechecks an unchanged draft.
 *
 * So a `--for-agent` JSON command marks itself running when it starts and keeps its complete result
 * when it ends, refusals included; `result last --wait` waits until no command of the checkout is
 * still running and returns the newest result kept (or the newest of one command). Machine-local,
 * the last few results per checkout, keyed by the checkout's top (found by walking up to `.git`, with
 * no Git process): nothing is written into the checkout, so keeping a result never makes it dirty.
 * Best effort: keeping never fails or slows the command it keeps.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEPT_RESULT_SCHEMA = 'sflow-kept-agent-result@1';
const RUNNING_SCHEMA = 'sflow-running-agent-command@1';
export const KEPT_RESULTS_PER_CHECKOUT = 5;
// A marker older than this names a command that cannot still be running, whatever its process ID now is.
const RUNNING_STALE_MS = 6 * 60 * 60 * 1000;
export const RESULT_WAIT_DEFAULT_SECONDS = 45;
export const RESULT_WAIT_MAXIMUM_SECONDS = 300;

/** `SINGULARITY_FLOW_AGENT_RESULTS`, else `~/.singularity-flow/agent-results`. */
export function agentResultsRoot(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_AGENT_RESULTS || path.join(home, '.singularity-flow', 'agent-results'));
}

/** The checkout `cwd` is in (the nearest directory holding `.git`), or `cwd` itself outside one. */
function checkoutTop(cwd) {
  let directory;
  try { directory = realpathSync.native(cwd); } catch { directory = path.resolve(cwd); }
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    if (existsSync(path.join(cursor, '.git'))) return cursor;
    if (path.dirname(cursor) === cursor) return directory;
  }
}

/** The directory holding one checkout's running markers and kept results. */
export function agentResultsDirectory(cwd = process.cwd(), env = process.env) {
  const top = checkoutTop(cwd);
  return path.join(agentResultsRoot(env), createHash('sha256').update(top).digest('hex').slice(0, 24));
}

function writePrivate(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function entries(directory, schema) {
  let names = [];
  try { names = readdirSync(directory).filter((name) => name.endsWith('.json')); } catch { return []; }
  return names.map((name) => ({ file: path.join(directory, name), value: readJson(path.join(directory, name)) }))
    .filter(({ value }) => value?.schema === schema);
}

/** The command as an agent recognizes it: its words and option names, never option values. */
export function agentCommandText(argv) {
  const words = [];
  for (const token of argv) {
    if (token === '--') break;
    if (/^--[^=]+/u.test(token)) words.push(token.replace(/=.*$/u, ''));
    else if (!words.at(-1)?.startsWith('--')) words.push(token);
  }
  return `singularity-flow ${words.join(' ')}`.trim();
}

/**
 * Mark a command running; returns the handle `keepAgentResult` takes, or null when nothing can be
 * kept. A nested step of a composite command keeps nothing: the composite's own result is the one.
 */
export function beginAgentResult(argv, { cwd = process.cwd(), env = process.env, now = Date.now() } = {}) {
  if (globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH > 0) return null;
  try {
    const directory = agentResultsDirectory(cwd, env);
    const run = { id: randomBytes(8).toString('hex'), directory, command: agentCommandText(argv), startedAt: new Date(now).toISOString() };
    writePrivate(path.join(directory, 'running', `${run.id}.json`), `${JSON.stringify({ schema: RUNNING_SCHEMA, ...run, pid: process.pid })}\n`);
    return run;
  } catch { return null; }
}

/** Keep the complete result `text` of `run`, clear its running marker, and keep only the newest few. */
export function keepAgentResult(run, text, { now = Date.now() } = {}) {
  // A nested step's own output or refusal is never the composite's result.
  if (!run || run.kept || globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH > 0) return;
  run.kept = true;
  try {
    const keptDirectory = path.join(run.directory, 'kept');
    writePrivate(path.join(keptDirectory, `${String(now).padStart(15, '0')}-${run.id}.json`), `${JSON.stringify({ schema: KEPT_RESULT_SCHEMA,
      id: run.id, command: run.command, startedAt: run.startedAt, finishedAt: new Date(now).toISOString(), output: String(text) })}\n`);
    rmSync(path.join(run.directory, 'running', `${run.id}.json`), { force: true });
    const names = readdirSync(keptDirectory).filter((name) => name.endsWith('.json')).sort();
    for (const name of names.slice(0, Math.max(0, names.length - KEPT_RESULTS_PER_CHECKOUT))) rmSync(path.join(keptDirectory, name), { force: true });
  } catch { /* Best effort: the command's own output is unchanged. */ }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

const runningNow = (marker, now) => alive(marker.pid) && now - Date.parse(marker.startedAt) < RUNNING_STALE_MS;
const brief = ({ command, startedAt, finishedAt }) => ({ command, startedAt, ...(finishedAt ? { finishedAt } : {}) });

/**
 * The checkout's newest kept result (of the command starting with `command`, when given), after
 * waiting up to `wait` seconds for every command of the checkout still running.
 * `{ status: 'kept', kept, others }` · `{ status: 'running', running }` (still running when the wait
 * ended) · `{ status: 'interrupted', interrupted }` (a newer command ended without keeping a result)
 * · `{ status: 'none' }`.
 */
export async function lastAgentResult({ cwd = process.cwd(), env = process.env, wait = 0, command = null,
  clock = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const directory = agentResultsDirectory(cwd, env);
  const deadline = clock() + Math.max(0, wait) * 1000;
  const markers = () => entries(path.join(directory, 'running'), RUNNING_SCHEMA);
  const wanted = (entry) => !command || entry.command === `singularity-flow ${command}`.trim()
    || entry.command.startsWith(`singularity-flow ${String(command).trim()} `);
  // Only the named command's run is waited for: another command still running is not its result.
  let active = markers().filter(({ value }) => runningNow(value, clock()) && wanted(value));
  while (active.length && clock() < deadline) {
    await sleep(Math.min(500, Math.max(1, deadline - clock())));
    active = markers().filter(({ value }) => runningNow(value, clock()) && wanted(value));
  }
  if (active.length) return { status: 'running', running: active.map(({ value }) => brief(value)) };
  const kept = entries(path.join(directory, 'kept'), KEPT_RESULT_SCHEMA).sort((a, b) => (a.file < b.file ? 1 : -1)).map(({ value }) => value);
  // Every marker left now is a command that ended; one without a kept result was interrupted or killed.
  const ended = markers().filter(({ value }) => !runningNow(value, clock()));
  for (const { file } of ended) rmSync(file, { force: true });
  const newest = kept.find(wanted) ?? null;
  const interrupted = ended.map(({ value }) => value).filter((value) => !kept.some((entry) => entry.id === value.id)).filter(wanted)
    .filter((value) => !newest || Date.parse(value.startedAt) > Date.parse(newest.finishedAt))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  if (interrupted) return { status: 'interrupted', interrupted: brief(interrupted) };
  if (!newest) return { status: 'none' };
  return { status: 'kept', kept: newest, others: kept.filter((entry) => entry !== newest).map(brief) };
}
