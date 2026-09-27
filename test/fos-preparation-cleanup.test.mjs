import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FosGitObjectService } from '../src/fos-object-service.mjs';

async function markerPid(marker) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try { return Number(await readFile(marker, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error('Private fixture preparation did not start within its bound.');
}

test('FOS close awaits cancelled internally owned profile setup and refuses unproven cleanup', {
  skip: process.platform === 'win32' ? 'The delayed POSIX executable fixture requires a shebang launcher.' : false
}, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-preparation-'));
  const marker = path.join(base, 'started.pid');
  const executable = path.join(base, 'git');
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');\nprocess.on('SIGTERM',()=>{});\nfs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\nsetInterval(()=>{},1000);\n`);
  await chmod(executable, 0o755);
  const service = new FosGitObjectService(base, { executable, timeoutMs: 5_000 });
  let pid;
  t.after(async () => {
    await service.close();
    // Only this private fixture's exact child may be cleaned if an assertion fails before close.
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(base, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const pending = service.read('a'.repeat(40), { signal: controller.signal });
  const refused = assert.rejects(pending, { code: 'OBJECT_REQUEST_CANCELLED' });
  pid = await markerPid(marker);
  controller.abort();
  await refused;
  const began = performance.now();
  const outcome = await service.close();
  assert.deepEqual(outcome, { closed: true, terminated: false }, 'an interrupted setup must not invent process-tree proof');
  assert.ok(performance.now() - began >= 500, 'close must await the delayed setup retirement, not only the absent object worker');
  assert.ok(performance.now() - began < 3_000, 'cleanup uses the existing bounded process grace');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
