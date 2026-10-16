import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { warmReadRequest, readWorkerBuildFingerprint } from '../src/read-worker-protocol.mjs';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { SingularityFlowClient } from '../apps/vscode/src/cli/client.ts';

// Reports legitimately contain read-time clocks. Compare every semantic field; only exclude
// their two generatedAt fields, rendered clock line, and the hashes derived from those clocks.
function comparable(value) {
  const copy = structuredClone(value);
  if (copy.lifecycle?.report) delete copy.lifecycle.report.generatedAt;
  if (copy.lifecycle?.review) {
    delete copy.lifecycle.review.generatedAt;
    if (copy.lifecycle.review.markdown) copy.lifecycle.review.markdown = copy.lifecycle.review.markdown.replace(/^- Generated: .*$/mu, '- Generated: <read-time>');
  }
  if (copy.lifecycle) { delete copy.revision.subjectRevision; delete copy.revision.slices.lifecycle; }
  return copy;
}

test('worker vocabulary excludes mutations, author/reviewer packets and unqualified full snapshots', () => {
  for (const args of [[], ['snapshot', '--json'], ['snapshot', '--include', 'diagnostics', '--json'],
    ['status', '--submission-readiness', '--json'], ['nextsteps', '--for-agent', '--json'],
    ['status', '../escape', '--json'], ['phase', 'prepublish', 'intake', '--json'],
    ['approve', 'intake', '--json'], ['status', '--json', '--json']]) assert.equal(warmReadRequest(args), null, args.join(' '));
  assert.deepEqual(warmReadRequest(['snapshot', '--include', 'repository', '--json']), {
    method: 'snapshot', included: ['repository'], ifRevision: null
  });
  assert.deepEqual(warmReadRequest(['nextsteps', 'PERF-001', '--json']), { method: 'nextsteps', workId: 'PERF-001' });
});

test('unstamped editable sources use CLI fallback', async () => {
  assert.equal(await readWorkerBuildFingerprint(path.resolve('bin/singularity-flow.mjs')), null);
});

test('private worker matches cold canonical reads and freshly observes repository/configuration changes', { timeout: 120_000 }, async t => {
  const f = await createWarmReadFixture();
  const adapter = await import(pathToFileURL(path.join(f.engine, 'src/read-worker-client.mjs')).href);
  t.after(async () => { adapter.disposeReadWorkers(); await f.cleanup(); });
  const read = (args, overrides = {}) => adapter.readWithWorker({ executable: process.execPath,
    cli: f.cli, repository: f.repository, env: f.env, args, ...overrides });
  for (const args of [['snapshot', '--include', 'repository', '--json'],
    ['snapshot', '--include', 'repository', '--include', 'lifecycle', '--include', 'capabilities', '--json'],
    ['status', 'PERF-001', '--json'], ['nextsteps', 'PERF-001', '--json']]) {
    const cold = f.cold(args), warm = await read(args);
    assert.equal(warm?.kind, 'value', args.join(' '));
    assert.deepEqual(comparable(warm.value), comparable(cold), `canonical parity except read-time clocks: ${args.join(' ')}`);
    assert.equal((await read(args)).transport, 'warm-worker');
  }
  const status = ['status', 'PERF-001', '--json'];
  f.state.workItem.title = 'Updated outside worker';
  await writeFile(f.statePath, JSON.stringify(f.state));
  assert.equal((await read(status)).value.workItem.title, 'Updated outside worker');
  assert.deepEqual((await read(status)).value, f.cold(status));
  const snapshot = ['snapshot', '--include', 'repository', '--json'];
  const before = (await read(snapshot)).value;
  await writeFile(path.join(f.repository, 'new-file.txt'), 'external edit\n');
  const after = (await read(snapshot)).value;
  assert.notEqual(after.revision.subjectRevision, before.revision.subjectRevision);
  assert.deepEqual(after, f.cold(snapshot));
  assert.equal((await read(status, { env: { ...f.env, PERMISSION_SCOPE: 'changed' } })).transport, 'worker-start');
  assert.equal((await read(status)).transport, 'worker-start', 'old environment is not a reusable session');
  adapter.invalidateReadWorkers(f.repository);
  assert.equal((await read(status)).transport, 'worker-start');
  const stamp = path.join(f.engine, 'src/build-info.mjs');
  await writeFile(stamp, (await readFile(stamp, 'utf8')).replace('1'.repeat(40), '2'.repeat(40)));
  assert.equal((await read(status)).transport, 'worker-start', 'replaced installed build restarts');
  await writeFile(stamp, (await readFile(stamp, 'utf8')).replace(`commit: '${'2'.repeat(40)}'`, 'commit: null')
    .replace('sourceSha256: null', `sourceSha256: 'sha256:${'3'.repeat(64)}'`));
  assert.equal((await read(status)).transport, 'worker-start', 'no-Git content-stamped reinstall also qualifies');
  adapter.disposeReadWorkers();
  for (let index = 0; index < 65; index++) {
    const reply = await read(status);
    assert.equal(reply.transport, index === 0 || index === 64 ? 'worker-start' : 'warm-worker', '64-read retirement is bounded');
  }
  const inFlightAbort = new AbortController();
  const pending = read(status, { signal: inFlightAbort.signal });
  setImmediate(() => inFlightAbort.abort(new Error('cancel during startup or read')));
  await assert.rejects(pending, /cancel during startup or read/);
  const script = path.join(f.engine, 'src/read-worker.mjs'), original = await readFile(script, 'utf8');
  await writeFile(script, "process.on('message', () => process.send({ type: 'malformed' }));\n");
  assert.equal(await read(status), null, 'malformed worker responses never become a usable read packet');
  await writeFile(script, original);
  assert.equal(await read(['approve', 'intake', '--json']), null);
  const abort = new AbortController(); abort.abort(new Error('cancelled by subscriber'));
  await assert.rejects(read(status, { signal: abort.signal }), /cancelled by subscriber/);
  adapter.disposeReadWorkers();
  const invalidExecutable = path.join(f.directory, 'not-a-node-executable');
  assert.equal(await read(status, { executable: invalidExecutable }), null, 'worker failure returns CLI fallback, not a false packet');
  const timings = [], output = [];
  const client = new SingularityFlowClient({ location: { executable: process.execPath, cli: f.cli, source: 'setting' },
    repository: f.repository, environment: f.env, onTiming: timing => timings.push(timing),
    onOutput: line => output.push(line) });
  t.after(() => client.dispose());
  assert.equal((await client.run(status)).workItem.id, 'PERF-001');
  assert.ok(output.some(line => line.startsWith('[Singularity Flow read]')), 'real extension adapter uses the worker');
  assert.equal(timings.length, 0, 'a warm request did not secretly launch the CLI too');
  await assert.rejects(client.run(['status', 'MISSING-STORY', '--json']));
  assert.equal(timings.length, 1, 'a refused worker read has exactly one authoritative CLI fallback');
});

test('worker rejects a non-private or malformed IPC binding', { timeout: 30_000 }, async () => {
  const child = fork(path.resolve('src/read-worker.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.send({ type: 'bind', nonce: 'invented' });
  assert.equal(await exited, 1);
});
