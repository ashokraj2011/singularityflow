import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('benchmark probe counts each callback, promisified and sync process once without retaining data', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-probe-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'counts.jsonl');
  const script = `import assert from 'node:assert/strict';
    import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
    import { promisify } from 'node:util';
    const callback = exe => new Promise((resolve,reject) => execFile(exe, exe === 'git' ? ['--version'] : [], e => e ? reject(e) : resolve()));
    await callback('git');
    const pending = promisify(execFile)('git', ['--version']);
    assert.ok(pending.child?.pid); assert.equal(typeof (await pending).stdout, 'string');
    execFileSync('git', ['--version']);
    assert.equal(spawnSync('git', ['--version']).status, 0);
    await new Promise((resolve,reject) => { const child=spawn('git', ['--version']); child.stdout.resume(); child.stderr.resume(); child.on('error',reject); child.on('close',code=>code===0?resolve():reject(Error('Git failed'))); });
    await callback('whoami'); await promisify(execFile)('whoami', []); execFileSync('whoami');`;
  const result = spawnSync(process.execPath, ['--import', new URL('../scripts/benchmark-git-probe.mjs', import.meta.url).href,
    '--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8',
    env: { ...process.env, SFLOW_BENCHMARK_GIT_COUNTS: output } });
  assert.equal(result.status, 0, result.stderr);
  const raw = await readFile(output, 'utf8'), data = JSON.parse(raw);
  assert.equal(Object.values(data.counts).reduce((a,b)=>a+b, 0), 5);
  assert.equal(data.systemCounts.whoami, 3);
  assert.ok(data.elapsedMs.other > 0); assert.ok(data.systemElapsedMs.whoami > 0);
  assert.ok(!raw.includes(directory)); assert.ok(!raw.includes('--version'));
  assert.ok(!raw.includes('git version')); assert.ok(!raw.includes('stdout'));
});
