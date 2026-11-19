/**
 * Git and remote work SFlow starts by itself waits until the laptop has been idle (machine-activity.mjs) [owner,
 * 2026-11-19]: clean-up of finished Story folders, Git's history index and the check for a newer SFlow. Spec Studio's
 * automatic sharing asks laptopIdle itself. Anything a person asks for never comes here and runs at once.
 *
 * A job due while someone works is queued as one small file, and one waiting process (automatic-work-runner.mjs)
 * starts it once the laptop has been quiet long enough. The runner sleeps for exactly the time left and looks again
 * if someone was active meanwhile: nothing polls. It gives up after a day; the next due job starts another.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { activityFile, idleMinutes, idleState } from './machine-activity.mjs';
import { osIdleMilliseconds } from './platform-process.mjs';

// From src/ in both layouts, like the clean-up worker: the bundle sits beside src/.
const RUNNER = fileURLToPath(new URL('../src/automatic-work-runner.mjs', import.meta.url));
export const MAXIMUM_WAIT_MS = 24 * 60 * 60_000;
const RUNNER_FILE = 'runner.json';

export function automaticWorkDirectory(env = process.env) {
  return path.join(path.dirname(activityFile(env)), 'automatic-work');
}

/** The operating system's input idle time, unless an isolated run switched reading it off. */
function systemIdle(env) {
  return env.SINGULARITY_FLOW_OS_IDLE === 'off' ? null : osIdleMilliseconds({ environment: env });
}

/**
 * Whether the laptop has been idle for SINGULARITY_FLOW_IDLE_MINUTES (30 by default): `{ idle, remainingMs }`.
 * The operating system is asked only when the stamp alone says idle, so a laptop in use costs one stat.
 */
export async function laptopIdle({ env = process.env, now = Date.now(), readSystemIdle = systemIdle } = {}) {
  const stamped = idleState({ env, now });
  if (!stamped.idle || idleMinutes(env) === 0) return stamped;
  return idleState({ env, now, osIdleMs: await readSystemIdle(env) });
}

const absolute = value => typeof value === 'string' && value.length < 4096 && path.isAbsolute(value) && !/[\0\r\n]/u.test(value);
/** The jobs a runner starts, each by the launch its own module owns; a file naming anything else is dropped. */
const JOBS = Object.freeze({
  'workspace-cleanup': job => absolute(job.workspacePath) && Array.isArray(job.protect) && job.protect.length <= 32 && job.protect.every(absolute),
  'history-index': job => absolute(job.root),
  'build-currency': job => absolute(job.checkout) && absolute(job.rawFile)
});

function queue(job, env) {
  if (!JOBS[job?.kind]?.(job)) return;
  const directory = automaticWorkDirectory(env);
  const file = path.join(directory, `${job.kind}-${createHash('sha256').update(JSON.stringify(job)).digest('hex').slice(0, 16)}.json`);
  if (existsSync(file)) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(job)}\n`, { mode: 0o600 });
}

function queued(directory) {
  let names = [];
  try { names = readdirSync(directory).filter(name => name.endsWith('.json') && name !== RUNNER_FILE).sort(); } catch { return []; }
  return names.flatMap((name) => {
    const file = path.join(directory, name);
    try {
      const job = JSON.parse(readFileSync(file, 'utf8'));
      if (JOBS[job?.kind]?.(job)) return [{ file, job }];
    } catch { /* unreadable: dropped below */ }
    rmSync(file, { force: true });
    return [];
  });
}

/** A runner recorded in `file` that is still waiting: its process is alive and it has not outlived its day. */
function runnerWaiting(file, now) {
  try {
    const { pid, startedAt } = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0 || !(now - Date.parse(startedAt) < MAXIMUM_WAIT_MS + 60_000)) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) { return error?.code === 'EPERM'; }
}

async function launchRunner(env) {
  const { spawnBackground } = await import('./background-process.mjs');
  spawnBackground(process.execPath, [RUNNER], { cwd: automaticWorkDirectory(env), env });
}

/**
 * Start `start` now when the laptop is idle; otherwise queue `job` for the one waiting runner, starting it when none
 * waits. 'started' or 'waiting'. A job that cannot be queued is simply asked for again at its next due time.
 */
export async function whenLaptopIdle(job, start, { env = process.env, now = Date.now(), idle = laptopIdle, launch = launchRunner } = {}) {
  if ((await idle({ env, now })).idle) {
    await start();
    return 'started';
  }
  try {
    queue(job, env);
    if (!runnerWaiting(path.join(automaticWorkDirectory(env), RUNNER_FILE), now)) await launch(env);
  } catch { /* asked for again when next due */ }
  return 'waiting';
}

function claim(directory, pid, now) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, RUNNER_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify({ pid, startedAt: new Date(now).toISOString() }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST' || runnerWaiting(file, now)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

function release(directory, pid) {
  const file = path.join(directory, RUNNER_FILE);
  try { if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) rmSync(file, { force: true }); } catch { /* already gone */ }
}

async function startJob(job, env) {
  if (job.kind === 'workspace-cleanup') return (await import('./workspace-retention-background.mjs')).launchRetentionWorker(job.workspacePath, job.protect, env);
  if (job.kind === 'history-index') return (await import('./history-index.mjs')).launchHistoryIndexWorker(job.root, env);
  return (await import('./build-currency.mjs')).startBuildCurrencyRefresh(job.checkout, job.rawFile);
}

/**
 * The runner: wait until the laptop is idle, start every queued job, and stop when none is left. 'done',
 * 'gave-up' after a day of activity, or 'already-waiting' when another runner holds the queue.
 */
export async function runQueuedAutomaticWork({ env = process.env, now = () => Date.now(), sleep = delay,
  idle = laptopIdle, start = startJob, pid = process.pid } = {}) {
  const directory = automaticWorkDirectory(env);
  if (!claim(directory, pid, now())) return 'already-waiting';
  const began = now();
  try {
    for (;;) {
      const jobs = queued(directory);
      if (!jobs.length) return 'done';
      const state = await idle({ env, now: now() });
      if (!state.idle) {
        if (now() - began >= MAXIMUM_WAIT_MS) return 'gave-up';
        // Re-armed for the time left since the latest activity, never a loop.
        await sleep(Math.min(MAXIMUM_WAIT_MS, state.remainingMs) + 1_000);
        continue;
      }
      for (const { file, job } of jobs) {
        rmSync(file, { force: true });
        try { await start(job, env); } catch { /* one job's failure never holds the others */ }
      }
    }
  } finally { release(directory, pid); }
}
