import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { invokeCli } from '../apps/vscode/src/cli/runner.ts';
import { configurePerformanceActions, withPerformanceAction, performanceActionId } from '../src/dx-timing-context.mjs';
import { createMessageRouter } from '../apps/vscode/src/views/messages.ts';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { readPerformanceReport } from '../src/performance-trace-store.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { end() {} }; child.kill = () => true;
  setImmediate(() => { child.stdout.emit('data', Buffer.from('{"okay":true}')); child.emit('close', 0); });
  return child;
}

test('host tracing is opt-in, preserves payloads and propagates only opaque correlation IDs', async t => {
  const repository = await mkdtemp(path.join(tmpdir(), 'sflow-host-trace-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const timings = [], environments = [];
  const invoke = env => invokeCli({ executable: 'node', cli: '/unused', repository, args: ['status'], env,
    spawnImpl: (_command, _args, options) => { environments.push(options.env); return fakeChild(); },
    onTiming: timing => timings.push(timing) });
  assert.deepEqual(await invoke({}), { okay: true });
  assert.equal(timings[0].performance, undefined);
  assert.equal(environments[0].SINGULARITY_FLOW_PERF_ACTION_ID, undefined);
  const action = randomUUID();
  assert.deepEqual(await invoke({ SINGULARITY_FLOW_PERF_TRACE: '1', SINGULARITY_FLOW_PERF_ACTION_ID: action }), { okay: true });
  assert.equal(timings[1].performance.actionId, action);
  assert.equal(environments[1].SINGULARITY_FLOW_PERF_ACTION_ID, action);
  assert.equal(environments[1].SINGULARITY_FLOW_PERF_PARENT_SPAN_ID, timings[1].performance.parentSpanId);
  assert.ok(timings[1].performance.firstByteMs >= 0);
  assert.ok(timings[1].performance.processMs >= timings[1].performance.launchCallMs);
  await invoke({ SINGULARITY_FLOW_PERF_TRACE: '1', SINGULARITY_FLOW_PERF_ACTION_ID: '/private/not-an-id' });
  assert.match(timings[2].performance.actionId, /^[a-f0-9-]{36}$/u);
  await invokeCli({ executable: 'node', cli: '/unused', repository, args: ['logs', 'performance', '--json'],
    env: { SINGULARITY_FLOW_PERF_TRACE: '1' }, spawnImpl: () => fakeChild(), onTiming: timing => timings.push(timing) });
  assert.equal(timings[3].performance, undefined, 'reading a report must not evict real traces with orphan host records');
});

test('action context is async-local, nested actions retain their parent and separate actions do not leak', async () => {
  const ids = await Promise.all([1, 2].map(() => withPerformanceAction(async () => {
    const id = performanceActionId();
    await Promise.resolve();
    assert.equal(await withPerformanceAction(async () => performanceActionId()), id);
    return id;
  })));
  assert.notEqual(ids[0], ids[1]);
  assert.equal(performanceActionId(), null);
});

test('lazy module copies and webview message routes share one opt-in host action', async t => {
  const duplicate = await import(new URL('../src/dx-timing-context.mjs?separate-bundle-copy', import.meta.url));
  configurePerformanceActions(true);
  t.after(() => configurePerformanceActions(false));
  const router = createMessageRouter('test', { run: async () => {
    const action = performanceActionId();
    assert.ok(action);
    assert.equal(duplicate.performanceActionId(), action);
    await Promise.resolve();
    return duplicate.withPerformanceAction(() => duplicate.performanceActionId());
  } }, () => {});
  const first = await router.route({ type: 'run' }), second = await router.route({ type: 'run' });
  assert.notEqual(first, second);
  assert.equal(performanceActionId(), null);
  configurePerformanceActions(false);
  const disabled = createMessageRouter('test', { run: () => performanceActionId() }, () => {});
  assert.equal(disabled.route({ type: 'run' }), null);
});

test('different trace IDs reuse the same private worker; diagnostics preserve fresh read semantics', slowLane({ timeout: 120_000 }), async t => {
  const f = await createWarmReadFixture();
  const adapter = await import(pathToFileURL(path.join(f.engine, 'src/read-worker-client.mjs')).href);
  t.after(async () => { adapter.disposeReadWorkers(); await f.cleanup(); });
  const args = ['status', 'PERF-001', '--json'];
  const first = randomUUID(), second = randomUUID();
  const read = action => adapter.readWithWorker({ executable: process.execPath, cli: f.cli,
    repository: f.repository, args, env: { ...f.env, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '0',
      SINGULARITY_FLOW_PERF_TRACE: '1', SINGULARITY_FLOW_PERF_ACTION_ID: action } });
  const cold = await read(first), warm = await read(second);
  assert.equal(cold.transport, 'worker-start');
  assert.equal(warm.transport, 'warm-worker');
  assert.deepEqual(cold.value, warm.value);
  assert.deepEqual(warm.value, f.cold(args));
  const report = await readPerformanceReport(path.join(f.repository, '.git', 'singularity-flow', 'dx'));
  assert.equal(report.traces.filter(trace => trace.actionId === first).length, 1);
  assert.equal(report.traces.filter(trace => trace.actionId === second).length, 1);
});
