/**
 * Replays an advisory read to refresh its projection (SDA §8, M2).
 *
 * A projection record names the read that produced it (`session candidates`, `workspace branches
 * --intake`). Refreshing it is that read run again with `SINGULARITY_FLOW_INDEX_REFRESH=1`, which
 * makes the cache skip its record, recompute under the record's refresh lease and keep the last-known
 * record if the authority cannot be reached. Behind a stale read it runs detached; `index refresh`
 * runs it in the foreground. Only the reads listed here are ever replayed.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { spawnBackground } from './background-process.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';

// Through the package root, so the bundled CLI (bundle/, one level deep) finds the same file.
const BIN = path.join(PACKAGE_ROOT, 'bin', 'singularity-flow.mjs');
export const INDEX_REFRESH_ENV = 'SINGULARITY_FLOW_INDEX_REFRESH';
export const INDEX_REFRESH_READS = Object.freeze([['session', 'candidates'], ['workspace', 'branches']]);
const OUTPUT_LIMIT = 64 * 1024;

/** Whether `argv` is one of the replayable reads, with no option a person must type. */
export function replayableIndexRead(argv) {
  return Array.isArray(argv) && argv.length <= 64 && argv.every((item) => typeof item === 'string' && !/[\0\r\n]/u.test(item))
    && INDEX_REFRESH_READS.some(([command, action]) => argv[0] === command && argv[1] === action)
    && !argv.some((item) => /^--(?:yes|confirm|force)(?:=|$)/u.test(item));
}

/** The argv that repeats a parsed read: its positionals, then `--key=value` options (parseArgs reads them back exactly). */
export function indexReadArgv(positionals, options, omit = []) {
  if (!positionals.every((item) => typeof item === 'string' && item && !item.startsWith('-'))) return null;
  const tokens = [];
  for (const [key, raw] of Object.entries(options).filter(([key]) => !omit.includes(key)).sort(([a], [b]) => a.localeCompare(b))) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (value === true) tokens.push(`--${key}`);
      else if (value === false) tokens.push(`--no-${key}`);
      else if (typeof value === 'string' || typeof value === 'number') tokens.push(`--${key}=${value}`);
      else return null;
    }
  }
  const argv = [...positionals, ...tokens, '--json'];
  return replayableIndexRead(argv) ? argv : null;
}

function environment(env) {
  const next = { ...env, [INDEX_REFRESH_ENV]: '1' };
  delete next.NODE_TEST_CONTEXT;
  return next;
}

/** In the background: no command waits for it, and its output is discarded. */
export function launchIndexRefresh({ argv, cwd }, env = process.env) {
  if (!replayableIndexRead(argv)) return null;
  const child = spawnBackground(process.execPath, [BIN, ...argv], { cwd, env: environment(env) });
  return { pid: child.pid ?? null };
}

/** Foreground, bounded: the status and the tail of what the read printed. */
export function runIndexRefresh({ argv, cwd }, env = process.env, { timeoutMs = 120_000 } = {}) {
  if (!replayableIndexRead(argv)) return Promise.resolve({ status: null, error: 'not-replayable' });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...argv], { cwd, env: environment(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); resolve({ status: null, error: error.code ?? 'spawn-failed' }); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, ...(signal ? { error: `signal ${signal}` } : {}), stderr: stderr.slice(-2_000) });
    });
  });
}
