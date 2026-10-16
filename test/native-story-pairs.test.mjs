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

test('a stop issued while a native turn runs survives that turn', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-stop-during-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { chmod, mkdir } = await import('node:fs/promises');
  const base = path.join(directory, 'after-1'); await mkdir(base);
  const prompt = path.join(base, 'request.md'); await writeFile(prompt, 'Disposable request.');
  const manifest = path.join(directory, 'native-pairs.json');
  await writeFile(manifest, JSON.stringify({ model: 'fixture-model', pairs: [
    { pair: 1, mode: 'after', status: 'prepared', root: base, base, bin: base, prompt, env: {} },
    { pair: 1, mode: 'before', status: 'prepared', root: base, base, bin: base, prompt, env: {} }] }));
  // A stand-in for the provider CLI: the person stops the qualification while this turn runs.
  const fake = path.join(directory, 'copilot');
  await writeFile(fake, `#!/bin/sh\n${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} stop ${JSON.stringify(directory)} >/dev/null\nexit 0\n`);
  await chmod(fake, 0o755);
  const invoke = action => spawnSync(process.execPath, [runner, action, directory], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: directory }
  });
  const ran = invoke('run-next');
  assert.equal(ran.status, 0, ran.stderr);
  const after = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(after.stoppedByUser, true, 'the stop recorded during the turn is kept');
  assert.equal(after.pairs[0].status, 'turn-completed-not-approved');
  const refused = invoke('run-next');
  assert.match(refused.stderr, /The user stopped native qualification/u);
});

test('native turns deny approval and machine resets, not only by prompt text', async () => {
  const source = await readFile(runner, 'utf8');
  for (const command of ['approve', 'reinstall', 'fresh-install', 'factory-reset', 'reset-all', 'local-reset']) {
    assert.ok(source.includes(`'${command}'`), command);
  }
  assert.match(source, /--deny-tool=shell\(singularity-flow \$\{command\}\)/u);
  assert.match(source, /process\.env\[key\] !== value/u, 'only fixture-set values are persisted, never ambient tokens');
});
