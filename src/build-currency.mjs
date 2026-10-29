/**
 * Whether this machine's SFlow is older than the main branch of the checkout it was installed from.
 *
 * Two laptops ran builds that predated the fixes for the very refusals they hit (2026-10-27), and
 * nothing said so. This never waits on the network: it reads a cached answer and, at most twice a
 * day, starts `git ls-remote` in a detached process whose output the next call reads. It warns only
 * when the checkout shows this build is an ancestor of main; a build from a branch ahead of main, a
 * checkout that is gone or unreachable, or an unstamped build says nothing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILD_INFO } from './build-info.mjs';

const REFRESH_MS = 12 * 60 * 60 * 1000;
const PENDING_MS = 10 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/u;

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const quoted = (value) => (/^[A-Za-z0-9._/@:-]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`);

/** The main commit a finished `ls-remote` wrote, when it is an answer this cache has not used yet. */
function remoteMain(rawFile, used) {
  try {
    const written = statSync(rawFile).mtimeMs;
    if (written === used) return null;
    const main = readFileSync(rawFile, 'utf8').split(/\s/u)[0];
    return SHA.test(main) ? { main, written } : null;
  } catch { return null; }
}

/**
 * How many commits this build is behind main: a count when the checkout has main, `'unknown'` when it
 * has not fetched it yet but the build sits on its own last-fetched main (the usual case: a person
 * who has not pulled since installing), 0 when the build is main, or null when nothing can be said
 * (a build from a branch ahead of main, say).
 */
function commitsBehind(checkout, commit, main) {
  if (commit === main) return 0;
  const git = (...args) => spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', timeout: 2000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (git('cat-file', '-e', `${main}^{commit}`).status !== 0) {
    return git('merge-base', '--is-ancestor', commit, 'refs/remotes/origin/HEAD').status === 0 ? 'unknown' : null;
  }
  if (git('merge-base', '--is-ancestor', commit, main).status !== 0) return null;
  const count = Number.parseInt(git('rev-list', '--count', `${commit}..${main}`).stdout, 10);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function startRefresh(checkout, rawFile) {
  try {
    const output = openSync(rawFile, 'w');
    const child = spawn('git', ['-C', checkout, 'ls-remote', 'origin', 'HEAD'], {
      detached: true, stdio: ['ignore', output, 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true
    });
    child.on('error', () => {});
    child.unref();
    closeSync(output);
  } catch { /* No Git or no checkout: nothing is said. */ }
}

/**
 * `{ behind, main, build, checkout, commands }` when this build is older than main, else null.
 * Reads the install record and writes only `build-currency*` in the installations folder
 * (SINGULARITY_FLOW_INSTALLATIONS_DIR, else ~/.singularity-flow/installations).
 */
export function buildCurrency({ env = process.env, now = Date.now(), commit = BUILD_INFO.commit,
  directory = env.SINGULARITY_FLOW_INSTALLATIONS_DIR ?? path.join(os.homedir(), '.singularity-flow', 'installations'),
  refresh = startRefresh } = {}) {
  if (!SHA.test(commit ?? '') || env.SINGULARITY_FLOW_NO_UPDATE_CHECK === '1') return null;
  const checkout = readJson(path.join(directory, 'current.json'))?.checkout;
  if (typeof checkout !== 'string' || !checkout) return null;
  const cacheFile = path.join(directory, 'build-currency.json');
  const rawFile = path.join(directory, 'build-currency.remote');
  let cache = readJson(cacheFile);
  // A new build or checkout (a reinstall) starts from a fresh answer, never the previous build's.
  if (cache?.commit !== commit || cache?.checkout !== checkout) {
    let written = null;
    try { written = statSync(rawFile).mtimeMs; } catch { /* none yet */ }
    cache = { commit, checkout, checkedAt: null, requestedAt: null, main: null, behind: null, remoteWritten: written };
  }
  const main = remoteMain(rawFile, cache.remoteWritten ?? null);
  if (main) cache = { ...cache, main: main.main, remoteWritten: main.written, behind: commitsBehind(checkout, commit, main.main), checkedAt: new Date(now).toISOString() };
  const stale = !cache.checkedAt || now - Date.parse(cache.checkedAt) >= REFRESH_MS;
  const pending = cache.requestedAt && now - Date.parse(cache.requestedAt) < PENDING_MS;
  if (stale && !pending) {
    cache = { ...cache, requestedAt: new Date(now).toISOString() };
    try { mkdirSync(directory, { recursive: true }); } catch { /* reported as nothing */ }
    refresh(checkout, rawFile);
  }
  if (main || (stale && !pending)) {
    try { writeFileSync(`${cacheFile}.tmp`, `${JSON.stringify(cache)}\n`, { mode: 0o600 }); renameSync(`${cacheFile}.tmp`, cacheFile); } catch { /* best effort */ }
  }
  if (!(cache.behind > 0 || cache.behind === 'unknown')) return null;
  return {
    behind: cache.behind, main: cache.main, build: commit, checkout,
    commands: [`git -C ${quoted(checkout)} pull --ff-only`, `singularity-flow reinstall --checkout ${quoted(checkout)} --dry-run`]
  };
}

/**
 * One line for a person: the update warning reached only Copilot's agent entry, so Shell users and
 * VS Code never saw it (2026-10-29). Shown by `status` and `doctor`.
 */
export function buildCurrencyLine(update) {
  if (!update) return null;
  const behind = update.behind === 'unknown' ? 'older than' : `${update.behind} commit${update.behind === 1 ? '' : 's'} behind`;
  return `SFlow here is ${behind} main of ${update.checkout}; update with: ${update.commands.join(', then ')}`;
}
