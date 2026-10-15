/** Qualification-only instrumentation, used separately from latency samples. No raw argv retained. */
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function physicalProcessProbe(directory) {
  const records = path.join(directory, 'physical-processes.jsonl');
  const hook = path.join(directory, 'physical-process-hook.mjs');
  await writeFile(hook, `import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const record = ${JSON.stringify(records)};
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = cp[name];
  cp[name] = function(...args) {
    const executable = String(args[0] ?? '').replaceAll('\\\\', '/').split('/').at(-1).toLowerCase();
    const kind = name === 'fork' ? 'node' : /^(?:git|git.exe)$/.test(executable) ? 'git' : /^(?:node|node.exe)$/.test(executable) ? 'node' : 'other';
    appendFileSync(record, JSON.stringify({ kind, pid: process.pid }) + '\\n');
    return Reflect.apply(original, this, args);
  };
}
syncBuiltinESMExports();
`);
  return {
    async environment(env) {
      await writeFile(records, '');
      return { ...env, NODE_OPTIONS: ((env.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(hook).href).trim() };
    },
    async counts(rootPid) {
      if ((await stat(records)).size > 512 * 1024) throw new Error('Qualification process observation limit exceeded.');
      const entries = (await readFile(records, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      const count = (kind, parent = null) => entries.filter(entry => entry.kind === kind
        && (parent == null || (entry.pid === rootPid) === parent)).length;
      return { git: { parent: count('git', true), descendants: count('git', false), total: count('git') },
        nodeChildren: count('node'), otherProcesses: count('other'),
        scope: 'All observed child_process launches in the CLI and inherited Node descendants; separate instrumented calls, not latency samples.' };
    }
  };
}
