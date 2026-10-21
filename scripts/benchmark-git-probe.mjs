/** Test-only preload: count Node-launched Git processes, including legacy direct spawn sites.
 * No command arguments, paths, URLs, configuration values or credentials are retained.
 */
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const output = process.env.SFLOW_BENCHMARK_GIT_COUNTS;
if (output) {
  const verbs = new Set(['add', 'branch', 'cat-file', 'check-ref-format', 'clone', 'commit', 'config',
    'diff', 'diff-tree', 'fetch', 'for-each-ref', 'hash-object', 'init', 'ls-files', 'ls-remote', 'ls-tree',
    'merge-base', 'push', 'read-tree', 'rev-list', 'rev-parse', 'show', 'show-ref', 'sparse-checkout',
    'status', 'switch', 'symbolic-ref', 'update-index', 'update-ref', 'worktree', 'write-tree']);
  const counts = {}, elapsedMs = {}, systemCounts = {}, systemElapsedMs = {};
  let delegationDepth = 0;
  const observe = (executable, args, invoke, asynchronous = false) => {
    const base = path.basename(String(executable)).toLowerCase().replace(/\.exe$/u, '');
    const system = ['powershell', 'whoami'].includes(base);
    if (delegationDepth || base !== 'git' && !system) return invoke();
    const verb = system ? base : (Array.isArray(args) ? args : []).find(value => verbs.has(value)) ?? 'other';
    const calls = system ? systemCounts : counts, elapsed = system ? systemElapsedMs : elapsedMs;
    const started = performance.now();
    calls[verb] = (calls[verb] ?? 0) + 1;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; elapsed[verb] = (elapsed[verb] ?? 0) + performance.now() - started; } };
    let result;
    delegationDepth++;
    try { result = invoke(); }
    catch (error) { finish(); throw error; }
    finally { delegationDepth--; }
    const child = asynchronous ? result?.child : result;
    if (typeof child?.once === 'function') child.once('close', finish);
    else if (asynchronous && typeof result?.then === 'function') result.then(finish, finish);
    else finish();
    return result;
  };
  for (const api of ['spawn', 'spawnSync', 'execFileSync', 'execFile']) {
    const original = childProcess[api];
    childProcess[api] = function (executable, args, ...rest) {
      return observe(executable, args, () => original.call(this, executable, args, ...rest));
    };
    // Native execFile's custom promisifier closes over the original function, bypassing the
    // patched export. Observe that boundary too while retaining its result shape and .child.
    for (const symbol of Object.getOwnPropertySymbols(original)) {
      const descriptor = Object.getOwnPropertyDescriptor(original, symbol);
      if (symbol === promisify.custom && typeof descriptor.value === 'function') {
        const custom = descriptor.value;
        descriptor.value = function (executable, args, ...rest) {
          return observe(executable, args, () => custom.call(this, executable, args, ...rest), true);
        };
      }
      Object.defineProperty(childProcess[api], symbol, descriptor);
    }
  }
  syncBuiltinESMExports();
  process.once('exit', () => appendFileSync(output, `${JSON.stringify({ counts, elapsedMs, systemCounts, systemElapsedMs })}\n`));
}
