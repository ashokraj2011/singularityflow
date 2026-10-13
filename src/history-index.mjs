/**
 * Git's changed-path index for long histories, written once in the background. `[perf]`
 *
 * Phase commands ask Git which commit added or changed a Story file (`git log -- <path>`), and each
 * such question walks the repository's whole history. On a 30,000-commit repository one walk takes
 * about 124 ms with a plain commit graph and 282 ms without one; with Git's changed-path filters
 * (`git commit-graph write --changed-paths`) it takes about 41 ms, because Git can skip every commit
 * that cannot have touched the path. The filters are derived data inside `.git`, maintained by Git
 * itself afterwards; they never change an answer, only how fast Git finds it.
 *
 * After a mutating command this checks, with a few `stat` calls and no Git process, whether the
 * repository is large enough to matter and lacks the filters. Only then does it start one detached
 * worker that writes them, so no command waits for it. It does nothing in a shallow clone (Git
 * cannot write a commit graph there), in a partial clone that left out trees (writing would
 * download every tree), or when `SINGULARITY_FLOW_HISTORY_INDEX=off`.
 */
import { spawn } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./history-index-worker.mjs', import.meta.url));
// Below this much packed history a walk is already fast; small repositories (and every test
// fixture) pay only the stat calls.
const DEFAULT_MINIMUM_PACK_BYTES = 8 * 1024 * 1024;
// A started write is not started again for this long, whether it finished or not.
const RETRY_AFTER_MS = 60 * 60 * 1000;
export const HISTORY_INDEX_WRITE = ['commit-graph', 'write', '--reachable', '--changed-paths', '--split=replace'];

/** The shared Git directory of the checkout at `root`, from the filesystem. */
function commonDirectory(root) {
  const marker = path.join(root, '.git');
  let info;
  try { info = lstatSync(marker); } catch { return null; }
  if (info.isDirectory()) return marker;
  if (!info.isFile() || info.size > 4_096) return null;
  const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/mu.exec(readFileSync(marker, 'utf8'))?.[1];
  if (!pointer) return null;
  const gitDir = path.resolve(root, pointer);
  try { return path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { return gitDir; }
}

function exists(file) {
  try { lstatSync(file); return true; } catch { return false; }
}

function packBytes(common) {
  const directory = path.join(common, 'objects', 'pack');
  let total = 0;
  try {
    for (const name of readdirSync(directory)) {
      if (name.endsWith('.pack')) total += statSync(path.join(directory, name)).size;
    }
  } catch { return 0; }
  return total;
}

/** Whether one commit-graph file carries changed-path filters (a BDAT chunk in its table). */
function graphHasFilters(file) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const header = Buffer.alloc(8);
    if (readSync(descriptor, header, 0, 8, 0) !== 8 || header.toString('latin1', 0, 4) !== 'CGPH') return false;
    const table = Buffer.alloc(12 * (header[6] + 1));
    if (readSync(descriptor, table, 0, table.length, 8) !== table.length) return false;
    for (let offset = 0; offset < table.length; offset += 12) {
      if (table.toString('latin1', offset, offset + 4) === 'BDAT') return true;
    }
    return false;
  } catch { return false; } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Every layer of the repository's commit graph has filters (a layer without them is a gap). */
export function historyIndexPresent(common) {
  const info = path.join(common, 'objects', 'info');
  let layers = [];
  try {
    layers = readFileSync(path.join(info, 'commit-graphs', 'commit-graph-chain'), 'utf8').split('\n')
      .map((line) => line.trim()).filter(Boolean).map((hash) => path.join(info, 'commit-graphs', `graph-${hash}.graph`));
  } catch { layers = exists(path.join(info, 'commit-graph')) ? [path.join(info, 'commit-graph')] : []; }
  return layers.length > 0 && layers.every(graphHasFilters);
}

function treesLeftOut(common) {
  try { return /^\s*partialclonefilter\s*=\s*tree:/imu.test(readFileSync(path.join(common, 'config'), 'utf8')); } catch { return true; }
}

/**
 * What the check decided for `root`, and the worker it started if any. Never throws: an index is
 * an optimisation, and no part of a command's outcome may depend on it.
 */
export function refreshHistoryIndex(root, {
  env = process.env, now = Date.now(), launch = launchWorker
} = {}) {
  try {
    if (String(env.SINGULARITY_FLOW_HISTORY_INDEX ?? '').toLowerCase() === 'off') return { status: 'off' };
    const common = commonDirectory(root);
    if (!common) return { status: 'not-a-repository' };
    if (exists(path.join(common, 'shallow'))) return { status: 'shallow' };
    const minimum = Number(env.SINGULARITY_FLOW_HISTORY_INDEX_MIN_PACK_BYTES ?? DEFAULT_MINIMUM_PACK_BYTES);
    if (packBytes(common) < (Number.isFinite(minimum) ? minimum : DEFAULT_MINIMUM_PACK_BYTES)) return { status: 'small' };
    if (historyIndexPresent(common)) return { status: 'present' };
    if (treesLeftOut(common)) return { status: 'trees-left-out' };
    const marker = path.join(common, 'singularity-flow', 'history-index.json');
    try {
      const started = Date.parse(JSON.parse(readFileSync(marker, 'utf8')).startedAt);
      if (Number.isFinite(started) && now - started < RETRY_AFTER_MS) return { status: 'started-recently' };
    } catch { /* No marker yet, or an unreadable one: start a write. */ }
    mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${JSON.stringify({ schemaVersion: 1, startedAt: new Date(now).toISOString() })}\n`, { mode: 0o600 });
    return { status: 'started', ...launch(root, env) };
  } catch {
    return { status: 'unavailable' };
  }
}

function launchWorker(root, env) {
  const child = spawn(process.execPath, [WORKER, root], {
    cwd: root, env, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true
  });
  child.once('error', () => {});
  child.unref();
  return { pid: child.pid ?? null };
}
