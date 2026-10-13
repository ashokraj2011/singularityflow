import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { configurationReadFromWorker } from '../src/configuration-read-worker-client.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { run } from '../src/util.mjs';

test('worker reuse is read-only, authenticated, repository-bound, disableable and restartable', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-read-worker-test-'));
  const root = path.join(base, 'repo'), foreign = path.join(base, 'foreign'), remote = path.join(base, 'remote.git');
  const workers = new Set();
  t.after(async () => { for (const pid of workers) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await rm(base, { recursive: true, force: true }); });
  run('git', ['init', '-q', '-b', 'main', root]);
  run('git', ['init', '-q', foreign]);
  run('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), 'unchanged\n');
  run('git', ['add', '.'], { cwd: root }); run('git', ['commit', '-qm', 'base'], { cwd: root });
  run('git', ['branch', 'sflow/config'], { cwd: root });
  run('git', ['clone', '-q', '--bare', '--', root, remote]);
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  const env = { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'registry.json') };
  const read = () => configurationReadFromWorker(root, 'proposals', {}, { env });
  const timer = commandTimer('worker-test', { commandClass: 'read' });
  let unsupported = false;
  await withCommandTiming(timer, async () => {
    const first = await read();
    if (!first && process.platform === 'win32') {
      unsupported = true; t.skip('Private worker ACL profile is unavailable; one-shot reads remain supported.'); return;
    }
    assert.deepEqual(first.value, []);
    assert.deepEqual((await read()).value, []);
  });
  if (unsupported) return;
  const counters = timer.finish().counters;
  assert.equal(counters['configuration.read-worker-start'], 1);
  assert.equal(counters['configuration.read-worker-reuse'], 2);
  assert.ok(counters['git.remote.command.ls-remote'] >= 2, 'every request freshly observes remote authority');
  const directory = path.join(root, '.git/singularity-flow/configuration-read-workers-v1');
  const descriptor = async () => {
    const name = (await readdir(directory)).find(entry => entry.endsWith('.json'));
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8')); workers.add(record.pid); return record;
  };
  const record = await descriptor();
  const send = body => new Promise(resolve => {
    const socket = connect(record.endpoint); let text = '';
    socket.setTimeout(2_000, () => socket.destroy()); socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ body,
      auth: createHmac('sha256', Buffer.from(record.token, 'hex')).update(JSON.stringify(body)).digest('hex') }) + '\n'));
    socket.on('data', chunk => { text += chunk; }); socket.on('error', () => {});
    socket.on('close', () => resolve(text));
  });
  const request = { format: 1, build: record.build, nonce: randomBytes(16).toString('hex'), root };
  assert.equal(await send({ ...request, method: 'activate' }), '', 'no mutation protocol exists');
  const refused = JSON.parse(await send({ ...request, root: foreign, method: 'proposals' }));
  assert.match(refused.body.error.message, /binding differs/u);
  assert.equal(await send({ ...request, build: 'different-build', method: 'proposals' }), '');
  assert.equal(await configurationReadFromWorker(root, 'proposals', {}, { env: { ...env,
    SINGULARITY_FLOW_CONFIGURATION_READ_WORKER: 'off' } }), null);
  assert.equal(await configurationReadFromWorker(root, 'activate', {}, { env }), null);
  process.kill(record.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(record.pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
    catch { break; }
  }
  assert.deepEqual((await read()).value, []);
  assert.notEqual((await descriptor()).pid, record.pid);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, '');
});
