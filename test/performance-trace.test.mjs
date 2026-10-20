import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPerformanceTrace, summarizePerformanceTrace } from '../src/performance-trace.mjs';
import { commandTimer, withCommandTiming, measureCommandSpan } from '../src/dx-command-timing.mjs';
import { measurePerformance } from '../src/dx-timing-context.mjs';
import { performanceReportText, readPerformanceReport, writePerformanceTrace, writeHostPerformanceTrace } from '../src/performance-trace-store.mjs';
import { run, readJson, snapshot } from '../src/util.mjs';
import { runRemoteGit, runRemoteGitAsync } from '../src/git-execution.mjs';
import { pinnedHttpRequest } from '../src/pinned-http.mjs';

test('nested spans preserve return types, exceptions, parents and non-overlapping attribution', async () => {
  let now = 0n;
  const trace = createPerformanceTrace({ clock: () => now, started: 0n, wallClock: () => 0 });
  const timer = commandTimer('phase', { trace, clock: () => now, started: 0n, wallClock: () => 0 });
  assert.equal(await withCommandTiming(timer, () => measureCommandSpan('phase-entry.binding', async () => {
    now = 1_000_000n;
    assert.equal(measurePerformance('file', 'file.read', () => { now = 4_000_000n; return 'hello'; }), 'hello');
    now = 6_000_000n;
    return 'result';
  })), 'result');
  now = 10_000_000n;
  const record = trace.finish();
  const summary = summarizePerformanceTrace(record);
  const by = Object.fromEntries(summary.categories.map(row => [row.category, row]));
  assert.equal(record.spans[1].parentId, record.spans[0].id);
  assert.equal(by.file.wallMs, 3);
  assert.equal(by.workflow.wallMs, 3);
  assert.equal(by.workflow.exclusiveServiceMs, 3);
  assert.equal(summary.unattributedMs, 4);
  assert.equal(by.file.bytes, 5);
  assert.equal(trace.finish(), record, 'sealing is idempotent');
});

test('parallel different resources become overlap, not a fake additive total', async () => {
  let now = 0n, release;
  const trace = createPerformanceTrace({ clock: () => now, started: 0n, wallClock: () => 0 });
  const pending = trace.run(() => trace.measure('network', 'http.request', () => new Promise(resolve => { release = resolve; })));
  now = 2_000_000n;
  const file = trace.run(() => trace.begin('file', 'file.read'));
  now = 5_000_000n; file.end();
  now = 7_000_000n; release('done'); await pending;
  now = 10_000_000n;
  const summary = summarizePerformanceTrace(trace.finish());
  assert.equal(summary.overlapMs, 3);
  assert.equal(summary.categories.find(row => row.category === 'network').wallMs, 4);
  assert.equal(summary.categories.reduce((total, row) => total + row.wallMs, 0) + summary.overlapMs + summary.unattributedMs, 10);
});

test('trace truncation, rejected content keys and failed operations stay explicit without changing errors', async () => {
  const trace = createPerformanceTrace({ maxSpans: 2 });
  const error = new TypeError('private original error');
  assert.throws(() => trace.run(() => trace.measure('file', 'file.read', () => { throw error; },
    { url: 'https://private.invalid/token', body: 'private content', bytes: 3 })), same => same === error);
  await assert.rejects(trace.run(() => trace.measure('network', 'http.request', async () => { throw error; })), same => same === error);
  assert.equal(trace.run(() => trace.measure('file', '/private/source/path', () => 42)), 42);
  const record = trace.finish();
  assert.equal(record.droppedSpans, 1);
  assert.equal(record.coverage.status, 'partial');
  assert.equal(record.spans[0].outcome, 'error');
  assert.doesNotMatch(JSON.stringify(record), /private|original error|token/u);
});

test('disabled instrumentation does not evaluate optional metric fields or change synchronous return types', () => {
  assert.equal(measurePerformance('file', 'file.read', () => 7, () => { throw new Error('must not run'); }), 7);
  assert.equal(commandTimer('status').trace, null);
});

test('malformed provider metric getters and non-string error codes cannot replace an operation result', () => {
  const trace = createPerformanceTrace();
  const value = { get performance() { throw new Error('private getter'); } };
  assert.equal(trace.measure('copilot', 'model.request', () => value), value);
  const failure = Object.assign(new Error('original'), { code: 42 });
  assert.throws(() => trace.measure('copilot', 'model.request', () => { throw failure; }), error => error === failure);
  assert.deepEqual(trace.finish().spans.map(span => span.outcome), ['unknown', 'error']);
});

test('thousands of concurrent spans are bounded and partition wall time without quadratic active comparisons', () => {
  let now = 0n;
  const trace = createPerformanceTrace({ clock: () => now, started: now, maxSpans: 4096 });
  const spans = Array.from({ length: 4096 }, (_, index) => trace.begin(index % 2 ? 'file' : 'network', 'file.read'));
  now = 1_000_000n;
  for (const span of spans) span.end();
  const summary = summarizePerformanceTrace(trace.finish());
  assert.equal(summary.overlapMs, 1);
  assert.equal(summary.unattributedMs, 0);
  assert.equal(summary.categories.reduce((sum, row) => sum + row.calls, 0), 4096);
});

test('timeout, cancellation and DNS failure stay classified without retaining provider diagnostics', async () => {
  const trace = createPerformanceTrace();
  const timer = commandTimer('phase', { trace });
  const timeout = Object.assign(new Error('private timeout detail'), { code: 'OBJECT_REQUEST_TIMEOUT' });
  await withCommandTiming(timer, async () => {
    assert.throws(() => measurePerformance('git-local', 'git.object-read', () => { throw timeout; }), error => error === timeout);
    measurePerformance('external', 'process.run', () => ({ error: { code: 'ETIMEDOUT' } }));
    measurePerformance('external', 'process.run', () => ({ aborted: true }));
    const result = await pinnedHttpRequest({ url: 'https://private.example.invalid/path?token=private', timeoutMs: 100,
      lookupImpl: async () => { throw new Error('private DNS error'); } });
    assert.equal(result.transport.code, 'STEP_ACTION_DNS_FAILED');
  });
  const record = trace.finish();
  assert.deepEqual(record.spans.map(span => span.outcome), ['timeout', 'timeout', 'cancelled', 'error', 'error']);
  assert.doesNotMatch(JSON.stringify(record), /private|example\.invalid|DNS error/u);
});

test('Git fact-cache hits finish their spans instead of leaving a false incomplete trace', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-trace-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const trace = createPerformanceTrace();
  await withCommandTiming(commandTimer('status', { trace }), () => {
    run('git', ['rev-parse', '--show-toplevel'], { cwd: root });
    run('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  });
  const record = trace.finish();
  assert.ok(record.spans.some(span => span.attributes.cache === 'hit'));
  assert.ok(record.spans.every(span => span.outcome === 'success'));
  assert.equal(record.coverage.status, 'instrumented-boundaries');
});

test('private store is bounded, readable without executing work, and refuses linked stores', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-traces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 4; index++) {
    const trace = createPerformanceTrace({ command: 'status' });
    trace.run(() => trace.measure('git-local', 'git.status', () => 'okay'));
    await writePerformanceTrace(root, trace.finish(), { env: { SINGULARITY_FLOW_PERF_MAX_RECORDS: '2' } });
  }
  assert.equal((await readdir(path.join(root, 'performance'))).filter(name => name.endsWith('.json')).length, 2);
  const report = await readPerformanceReport(root);
  assert.equal(report.traces.length, 2);
  assert.equal(report.traces[0].categories.find(row => row.category === 'git-local').calls, 1);
  const elsewhere = path.join(root, 'elsewhere'); await mkdir(elsewhere);
  if (process.platform !== 'win32') {
    const linked = path.join(root, 'linked'); await mkdir(linked);
    await symlink(elsewhere, path.join(linked, 'performance'));
    await assert.rejects(readPerformanceReport(linked), /Unsafe/);
  }
});

test('report projects untrusted diagnostic fields, ignores invalid records and joins only exact host correlation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-trace-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = createPerformanceTrace({ parentSpanId: randomUUID() });
  trace.measure('file', 'file.read', () => 'okay');
  const record = structuredClone(trace.finish());
  await writePerformanceTrace(root, record);
  const file = path.join(root, 'performance', `${record.invocationId}.json`);
  record.coverage.nativeCopilot = 'private prompt content';
  record.cpu.private = 'private key'; record.spans[0].attributes.url = 'https://private.example/';
  record.extra = 'private';
  await writeFile(file, JSON.stringify(record));
  await writeFile(path.join(root, 'performance', `${randomUUID()}.json`), '{broken');
  const host = { schemaVersion: 1, resultType: 'sflow-performance-host', parentSpanId: record.parentSpanId,
    actionId: record.actionId, durationMs: 10, parseMs: 2, queueMs: 3, extra: 'private' };
  await writeFile(path.join(root, 'performance', `${record.parentSpanId}.host.json`), JSON.stringify(host));
  const report = await readPerformanceReport(root);
  assert.equal(report.traces[0].host.queueMs, 3);
  assert.doesNotMatch(JSON.stringify(report), /private|example/u);
  assert.equal(report.traces[0].slowOperations[0].name, 'file.read');
  assert.equal(report.traces[0].timeline, undefined, 'slow-operation summaries require no full timeline response');
  assert.match(performanceReportText(report), /host: 10\.0ms/u);
  assert.equal(report.warnings.length, 1);
  host.actionId = randomUUID();
  await writeFile(path.join(root, 'performance', `${record.parentSpanId}.host.json`), JSON.stringify(host));
  assert.equal((await readPerformanceReport(root)).traces[0].host, null);
  await assert.rejects(readPerformanceReport(root, { actionId: '../../private' }), /opaque action/u);
});

test('report summaries include only the ten slowest sanitized operations, never stage spans or full timelines', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-slow-operations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 0n;
  const trace = createPerformanceTrace({ clock: () => now, started: 0n });
  for (let index = 0; index < 20; index++) {
    const span = trace.begin('file', `file.read-${index}`);
    now += BigInt(index + 1) * 1000000n;
    span.end();
  }
  trace.stage('execute', 0, 210);
  await writePerformanceTrace(root, trace.finish());
  const summary = (await readPerformanceReport(root)).traces[0];
  assert.equal(summary.timeline, undefined);
  assert.equal(summary.slowOperations.length, 10);
  assert.deepEqual(summary.slowOperations.map(row => row.durationMs), [20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
  assert.equal(summary.slowOperations[0].name, 'file.read-19');
  assert.deepEqual(Object.keys(summary.slowOperations[0]).sort(), ['category', 'durationMs', 'name', 'outcome']);
});

test('host observations use the exact main/linked-worktree store without Git requests or recreating reset stores', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-trace-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.name=Trace Tester', '-c', 'user.email=trace@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const linked = path.join(root, 'linked');
  git(['worktree', 'add', '-q', '-b', 'test-linked', linked]);
  const admin = git(['-C', linked, 'rev-parse', '--absolute-git-dir']);
  for (const [repository, directory] of [[root, path.join(root, '.git')], [linked, admin]]) {
    const base = path.join(directory, 'singularity-flow', 'dx');
    await mkdir(base, { recursive: true });
    const trace = createPerformanceTrace({ parentSpanId: randomUUID() });
    await writePerformanceTrace(base, trace.finish());
    const event = { durationMs: 4, stages: { queueMs: 1 }, performance: { actionId: trace.actionId,
      parentSpanId: trace.finish().parentSpanId, parseMs: 1, processMs: 3 } };
    await writeHostPerformanceTrace(repository, event);
    assert.equal((await readPerformanceReport(base)).traces[0].host.processMs, 3);
    await rm(path.join(base, 'performance'), { recursive: true });
    await writeHostPerformanceTrace(repository, event);
    assert.equal((await readPerformanceReport(base)).status, 'unavailable');
  }
});

test('real CLI classifies local Git, file access and Node stages; its report changes no governed files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-trace-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = (command, args, env = {}) => spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'unused-workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, 'unused-active.json'), ...env } });
  assert.equal(exec('git', ['init', '-q']).status, 0);
  await writeFile(path.join(root, 'data.json'), '{"answer":42}');
  const trace = createPerformanceTrace({ command: 'status' });
  const timer = commandTimer('status', { trace });
  await withCommandTiming(timer, async () => {
    assert.equal((await readJson(path.join(root, 'data.json'))).answer, 42);
    await snapshot(path.join(root, 'data.json'));
    run('git', ['rev-parse', '--git-dir'], { cwd: root });
    runRemoteGit(['ls-remote', 'https://example.invalid/private'], { cwd: root, env: { ...process.env, SINGULARITY_FLOW_NO_NETWORK: '1' } });
  });
  const record = trace.finish();
  assert.ok(record.spans.some(span => span.category === 'file'));
  assert.ok(record.spans.some(span => span.category === 'node' && span.name === 'file.hash'));
  assert.ok(record.spans.some(span => span.category === 'git-local'));
  assert.equal(record.spans.find(span => span.category === 'network').outcome, 'blocked');
  assert.doesNotMatch(JSON.stringify(record), /example\.invalid|data\.json/);
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const action = randomUUID();
  const invoked = exec(process.execPath, [cli, 'logs', 'path', '--timings'], {
    SINGULARITY_FLOW_PERF_TRACE: '1', SINGULARITY_FLOW_PERF_ACTION_ID: action });
  assert.equal(invoked.status, 0, invoked.stderr);
  const report = exec(process.execPath, [cli, 'logs', 'performance', '--action', action, '--timeline', '--json']);
  assert.equal(report.status, 0, report.stderr);
  const data = JSON.parse(report.stdout);
  assert.equal(data.status, 'available');
  assert.equal(data.traces[0].actionId, action);
  assert.ok(data.traces[0].timeline.some(span => span.kind === 'stage'));
  assert.equal(exec('git', ['status', '--porcelain']).stdout.trim(), '?? data.json');
});
