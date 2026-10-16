import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('../scripts/native-story-pairs.mjs', import.meta.url));

test('a human stop persists at Intake and prevents another native provider launch', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-stop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = path.join(directory, 'native-pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: [{ status: 'prepared' }] }));
  const invoke = action => spawnSync(process.execPath, [runner, action, directory], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, PATH: directory }
  });
  const stopped = invoke('stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  const retained = await readFile(manifest, 'utf8');
  assert.equal(JSON.parse(retained).stoppedByUser, true);
  assert.equal(JSON.parse(retained).stoppedAt, 'intake');
  const refused = invoke('run-next');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /The user stopped native qualification/u);
  assert.equal(await readFile(manifest, 'utf8'), retained);
});
