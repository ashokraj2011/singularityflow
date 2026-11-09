/**
 * Remote Git children: they end with the process that started them, a long wait says so, and a
 * session command does not probe a remote again that just left a probe unanswered. Loaded only for
 * real spawns (git-execution.mjs), so none of it is in the root dispatch closure.
 *
 * Detached Git children, and test commands, end when the process that started them ends.
 *
 * Remote Git runs in its own process group so a deadline can reach its credential helpers and
 * transports with one signal (git-execution.mjs), and so does a test command a gate runs, for its
 * runner's workers and the servers its tests start (quality-command-runner.mjs). That also means a
 * signal sent to this process's group misses them: VS Code stops a CLI call by signalling the
 * call's group, and Copilot stops a shell command the same way. A fetch blocked reading an
 * undownloaded cloud file kept running for as long as its read stayed blocked, long after the
 * command that wanted it had gone, and an interrupted publication left its test run behind.
 *
 * Live groups are therefore ended on exit and on SIGTERM, SIGINT and SIGHUP. A termination signal
 * nothing else handles still terminates the process, by re-raising it once the groups are gone.
 * One set of handlers serves every kind of group: two would each leave the re-raise to the other.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { isatty } from 'node:tty';
import { isSpawnedChild } from './platform-process.mjs';

const live = new Set();
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
let installed = false;

function endLiveGroups() {
  for (const pid of live) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  live.clear();
}

function onSignal(signal) {
  endLiveGroups();
  if (process.listenerCount(signal) > 1) return;
  for (const name of SIGNALS) process.removeListener(name, onSignal);
  process.removeListener('exit', endLiveGroups);
  installed = false;
  process.kill(process.pid, signal);
}

/** Track one detached child's group until it settles; returns the function that stops tracking. */
export function trackProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return () => {};
  live.add(pid);
  if (!installed) {
    installed = true;
    process.on('exit', endLiveGroups);
    for (const name of SIGNALS) process.on(name, onSignal);
  }
  return () => { live.delete(pid); };
}

/**
 * End what is left of the POSIX process group of a child that was started `detached` and then
 * stopped (a deadline, a cancel, an output limit), once the child closed; resolves when nothing of
 * the group is left. `close` proves only that the child's own pipes closed. A descendant that holds
 * none of them (stdio 'ignore') outlives it when it traps SIGTERM, or when it was being forked as
 * the group signal went out, and went on running after its run was reported stopped. The child's own
 * end is the end of a stop's grace, so the rest of its group gets SIGKILL, and again at every check:
 * a process forked during one sweep is reached by the next. Resolves false when a member outlives
 * `limitMs`; one blocked in the kernel dies when its call returns, SIGKILL already pending. Windows
 * has no group (taskkill /T ends the tree), and only a real child names one: a test double's `pid`
 * is never signalled. Callers load this module only once a stop happened.
 */
export async function endStoppedProcessGroup(child, { platform = process.platform, limitMs = 2_000 } = {}) {
  const pid = Number(child?.pid);
  if (platform === 'win32' || !isSpawnedChild(child) || !Number.isSafeInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + limitMs;
  for (;;) {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'EPERM') return true; }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/*
 * A Git child that is still waiting says so. A person or an agent watching a terminal saw nothing
 * for two minutes while a fetch waited out its deadline, and Copilot's shell tool reported only
 * "hasn't produced output yet". After 10 seconds, and every 30 after that, one line goes to the
 * terminal: what is waiting, for how long, and that it stops on its own at its deadline. It is
 * written to file descriptor 2 directly, so a composed command's captured step output and every
 * `--json` stdout stay exactly as they were, and only when that descriptor is a terminal (or
 * SINGULARITY_FLOW_GIT_PROGRESS=always): VS Code's piped CLI calls see nothing new.
 */
const PROGRESS_FIRST_MS = 10_000;
const PROGRESS_EVERY_MS = 30_000;

function progressWanted(env) {
  const mode = String(env?.SINGULARITY_FLOW_GIT_PROGRESS ?? '').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  try { return isatty(2); } catch { return false; }
}

/** The URL a remote command names: a frozen transport's alias (url.<URL>.insteadOf), or a URL argument. */
export function probedRemoteUrl(args, env) {
  const aliases = new Map();
  for (let index = 0; index < Number(env?.GIT_CONFIG_COUNT ?? 0); index += 1) {
    const key = /^url\.(.+)\.insteadof$/iu.exec(String(env[`GIT_CONFIG_KEY_${index}`] ?? ''));
    if (key) aliases.set(env[`GIT_CONFIG_VALUE_${index}`], key[1]);
  }
  for (const arg of args) {
    if (aliases.has(arg)) return aliases.get(arg);
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(String(arg))) return String(arg);
  }
  return null;
}

// What a waiting line names: the remote's host, a local remote's folder, else the working folder.
function waitTarget(args, env, cwd) {
  const url = probedRemoteUrl(args, env);
  if (!url) return path.basename(cwd);
  try { const parsed = new URL(url); return parsed.host || path.basename(parsed.pathname); } catch { return path.basename(url); }
}
const gitVerb = (args) => args.find((arg, index) => !String(arg).startsWith('-') && args[index - 1] !== '-c' && args[index - 1] !== '-C') ?? 'git';

/** Report a long wait for one Git child until the returned function is called. */
export function reportGitWait({ args, cwd, deadlineMs, env = process.env, write = (text) => writeSync(2, text) }) {
  if (!progressWanted(env)) return () => {};
  const verb = gitVerb(args);
  const target = waitTarget(args, env, cwd);
  const first = Number(env?.SINGULARITY_FLOW_GIT_PROGRESS_AFTER_MS);
  const firstMs = Number.isFinite(first) && first > 0 ? first : PROGRESS_FIRST_MS;
  const started = Date.now();
  const seconds = (ms) => Math.round(ms / 1000);
  const say = () => {
    try {
      write(`sflow: still waiting for Git ${verb}${target ? ` (${target})` : ''} after ${seconds(Date.now() - started)} s`
        + `${Number.isFinite(deadlineMs) ? ` (it stops by itself at ${seconds(deadlineMs)} s)` : ''}.\n`);
    } catch { /* a closed terminal must not fail the Git operation */ }
  };
  let repeat = null;
  const initial = setTimeout(() => { say(); repeat = setInterval(say, PROGRESS_EVERY_MS); repeat.unref?.(); }, firstMs);
  initial.unref?.();
  return () => { clearTimeout(initial); if (repeat) clearInterval(repeat); };
}

/*
 * A remote that just left a probe unanswered is not asked again within the same session command:
 * an unreachable remote cost two 30-second probes back to back when /sf-session refreshed. Only
 * callers inside withUnansweredRemoteReuse get the remembered answer; elsewhere (publication,
 * retries) every probe still goes to the remote.
 */
const unanswered = new Map();
const unansweredScope = new AsyncLocalStorage();
const UNANSWERED_MS = 60_000;
export const UNANSWERED_ADVICE = 'This remote did not answer a probe earlier in this command, so it was not asked again.';
export const withUnansweredRemoteReuse = (action) => unansweredScope.run(true, action);

/** The probe's remote, and how long ago it went unanswered in the current session command (else null). */
export function unansweredProbe(args, env) {
  const url = probedRemoteUrl(args, env);
  const at = url && unansweredScope.getStore() === true ? unanswered.get(url) : undefined;
  return { url, agoMs: at != null && Date.now() - at < UNANSWERED_MS ? Date.now() - at : null };
}

export function recordUnanswered(url) { unanswered.set(url, Date.now()); }
