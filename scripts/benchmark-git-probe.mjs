/** Test-only preload: count Node-launched Git processes, including legacy direct spawn sites.
 * No command arguments, paths, URLs, configuration values or credentials are retained.
 */
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const output = process.env.SFLOW_BENCHMARK_GIT_COUNTS;
if (output) {
  const verbs = new Set(['add', 'branch', 'cat-file', 'check-ref-format', 'clone', 'commit', 'config',
    'diff', 'diff-tree', 'fetch', 'for-each-ref', 'hash-object', 'init', 'ls-files', 'ls-remote', 'ls-tree',
    'merge-base', 'push', 'read-tree', 'rev-list', 'rev-parse', 'show', 'show-ref', 'sparse-checkout',
    'status', 'switch', 'symbolic-ref', 'update-index', 'update-ref', 'worktree', 'write-tree']);
  const counts = {}, elapsedMs = {}, systemCounts = {}, systemElapsedMs = {};
  for (const api of ['spawn', 'spawnSync', 'execFileSync', 'execFile']) {
    const original = childProcess[api];
    childProcess[api] = function (executable, args, ...rest) {
      const base = path.basename(String(executable)).toLowerCase().replace(/\.exe$/u, '');
      const system = ['powershell', 'whoami'].includes(base);
      if (base !== 'git' && !system) return original.call(this, executable, args, ...rest);
      // execFile delegates to spawn internally; avoid counting that internal launch twice.
      if (api === 'execFile' && !system) return original.call(this, executable, args, ...rest);
      const verb = system ? base : (Array.isArray(args) ? args : []).find(value => verbs.has(value)) ?? 'other';
      const calls = system ? systemCounts : counts, elapsed = system ? systemElapsedMs : elapsedMs;
      const started = performance.now();
      calls[verb] = (calls[verb] ?? 0) + 1;
      let finished = false;
      const finish = () => { if (!finished) { finished = true; elapsed[verb] = (elapsed[verb] ?? 0) + performance.now() - started; } };
      try {
        const result = original.call(this, executable, args, ...rest);
        if (api === 'spawn' || api === 'execFile') result.once('close', finish);
        else finish();
        return result;
      } catch (error) { finish(); throw error; }
    };
    // Preserve execFile's native promisified { stdout, stderr } contract.
    for (const symbol of Object.getOwnPropertySymbols(original)) {
      Object.defineProperty(childProcess[api], symbol, Object.getOwnPropertyDescriptor(original, symbol));
    }
  }
  syncBuiltinESMExports();
  process.once('exit', () => appendFileSync(output, `${JSON.stringify({ counts, elapsedMs, systemCounts, systemElapsedMs })}\n`));
}
