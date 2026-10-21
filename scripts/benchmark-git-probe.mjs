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
  const counts = {}, elapsedMs = {};
  for (const api of ['spawn', 'spawnSync', 'execFileSync']) {
    const original = childProcess[api];
    childProcess[api] = function (executable, args, ...rest) {
      if (!/^git(?:\.exe)?$/iu.test(path.basename(String(executable)))) return original.call(this, executable, args, ...rest);
      const verb = (Array.isArray(args) ? args : []).find(value => verbs.has(value)) ?? 'other';
      const started = performance.now();
      counts[verb] = (counts[verb] ?? 0) + 1;
      const finish = () => { elapsedMs[verb] = (elapsedMs[verb] ?? 0) + performance.now() - started; };
      try {
        const result = original.call(this, executable, args, ...rest);
        if (api === 'spawn') result.once('close', finish);
        else finish();
        return result;
      } catch (error) { finish(); throw error; }
    };
  }
  syncBuiltinESMExports();
  process.once('exit', () => appendFileSync(output, `${JSON.stringify({ counts, elapsedMs })}\n`));
}
