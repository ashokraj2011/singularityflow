/** A refresh or maintenance pass started behind an answer outlives the command that gave it. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalPathSync } from '../src/util.mjs';

const HELPER = pathToFileURL(fileURLToPath(new URL('../src/background-process.mjs', import.meta.url))).href;

/** Where the process `launch` starts ran, once the command that started it has exited; null if it never finished. */
async function outlives(base, name, launch) {
  const marker = path.join(base, `${name}.finished`);
  const child = path.join(base, `${name}.mjs`);
  // Long enough that the command which started it has certainly exited first.
  await writeFile(child, `import { writeFileSync } from 'node:fs';
setTimeout(() => writeFileSync(${JSON.stringify(marker)}, process.cwd()), 1500);\n`);
  const parent = spawnSync(process.execPath, ['--input-type=module', '-e', launch(child)], { cwd: base, encoding: 'utf8', timeout: 30_000 });
  assert.equal(parent.status, 0, parent.stderr);
  for (const deadline = Date.now() + 20_000; Date.now() < deadline && !existsSync(marker);) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return existsSync(marker) ? readFile(marker, 'utf8') : null;
}

test('a background process outlives the command that started it, in the directory it was given', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-background-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const work = path.join(base, 'work');
  await mkdir(work);
  const ran = await outlives(base, 'helper', (child) => `import { spawnBackground } from ${JSON.stringify(HELPER)};
spawnBackground(process.execPath, [${JSON.stringify(child)}], { cwd: ${JSON.stringify(work)} });`);
  assert.ok(ran !== null, 'the background process finished after the command that started it had exited');
  assert.equal(canonicalPathSync(ran), canonicalPathSync(work));
  // The Windows relay, on every host: its arguments arrive whole, and the process runs where it was given.
  const relayed = await outlives(base, 'relay', (child) => `import { spawnBackground } from ${JSON.stringify(HELPER)};
spawnBackground(process.execPath, [${JSON.stringify(child)}], { cwd: ${JSON.stringify(work)}, platform: 'win32' });`);
  assert.ok(relayed !== null, 'the relayed process finished after the command that started it had exited');
  assert.equal(canonicalPathSync(relayed), canonicalPathSync(work));
  if (process.platform !== 'win32') return;
  // Why the helper exists: on Windows a child started without `detached` ends with its parent.
  const plain = await outlives(base, 'plain', (child) => `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore', windowsHide: true }).unref();`);
  t.diagnostic(`a plain child ${plain === null ? 'ended with its parent' : 'outlived its parent'} on this Windows host`);
});

test('a background module answers its handshake and outlives the command that disconnected from it', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-background-fork-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const work = path.join(base, 'work');
  await mkdir(work);
  for (const platform of [process.platform, 'win32']) {
    const name = `fork-${platform === process.platform ? 'native' : 'relay'}`;
    const marker = path.join(base, `${name}.finished`);
    const module = path.join(base, `${name}.mjs`);
    await writeFile(module, `import { writeFileSync } from 'node:fs';
process.once('message', (packet) => {
  process.send({ ready: true, echo: packet.token });
  setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, process.cwd()); process.exit(0); }, 1500);
});\n`);
    // As configuration-proposal-sync.mjs does: send, wait for the answer, then disconnect and unreference.
    const launch = `import { forkBackground } from ${JSON.stringify(HELPER)};
const child = forkBackground(${JSON.stringify(module)}, [], { cwd: ${JSON.stringify(work)}, platform: ${JSON.stringify(platform)} });
const answer = await new Promise((resolve) => { child.once('message', resolve); child.once('exit', () => resolve(null)); child.send({ token: 'tok-1' }); });
child.disconnect(); child.unref();
process.stdout.write(JSON.stringify(answer));`;
    const parent = spawnSync(process.execPath, ['--input-type=module', '-e', launch], { cwd: base, encoding: 'utf8', timeout: 30_000 });
    assert.equal(parent.status, 0, parent.stderr);
    assert.deepEqual(JSON.parse(parent.stdout), { ready: true, echo: 'tok-1' }, `${name}: the answer crossed the channel`);
    for (const deadline = Date.now() + 20_000; Date.now() < deadline && !existsSync(marker);) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(existsSync(marker), `${name}: the module finished after the command that started it had exited`);
    assert.equal(canonicalPathSync(await readFile(marker, 'utf8')), canonicalPathSync(work));
  }
});
