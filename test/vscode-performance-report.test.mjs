import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PERFORMANCE_CATEGORIES as engineCategories } from '../src/performance-trace.mjs';
import { PERFORMANCE_CATEGORIES, emptyPerformanceFilters, filteredPerformanceTraces, performanceFiltersFrom,
  performanceReportFrom, PerformanceReportReader } from '../apps/vscode/src/views/performance-report-model.ts';
import { performanceReportBody, PERFORMANCE_REPORT_SCRIPT, PERFORMANCE_REPORT_STYLE } from '../apps/vscode/src/views/performance-report-page.ts';
import { sidebarDestination } from '../apps/vscode/src/views/sidebar-destination.ts';
import { page } from '../apps/vscode/src/views/webview.ts';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.parse('2026-10-20T12:00:00Z');
const trace = (n, extra = {}) => ({ actionId: uuid(100), invocationId: uuid(n), command: 'status',
  startedAt: '2026-10-20T11:30:00Z', durationMs: 100, outcome: 'success', platform: 'win32', temperature: 'cold',
  overlapMs: 15, unattributedMs: 5, firstFeedbackMs: 95, counters: { 'git.spawns': 2 },
  coverage: { status: 'instrumented-boundaries' }, spanCount: 4, droppedSpans: 0,
  categories: engineCategories.map(category => ({ category, wallMs: category === 'git-local' ? 80 : 0,
    calls: category === 'git-local' ? 2 : 0, inclusiveServiceMs: category === 'git-local' ? 120 : 0,
    exclusiveServiceMs: category === 'git-local' ? 110 : 0, errors: 0, timeouts: 0, cancellations: 0, cacheHits: 0, retries: 0 })),
  slowOperations: [{ name: 'git.status', category: 'git-local', outcome: 'success', durationMs: 90 }], ...extra });
const envelope = (...traces) => ({ resultType: 'sflow-performance-report', status: traces.length ? 'available' : 'unavailable', traces, warnings: [] });
const filters = (extra = {}) => ({ ...emptyPerformanceFilters(), ...extra });
const body = (extra = {}) => performanceReportBody({ repository: '/workspace/repository', report: performanceReportFrom(envelope(trace(1))),
  filters: filters(), selectedId: uuid(1), loading: false, captureEnabled: false, error: null, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('the report presents exactly the engine categories, with bounded projected data and no arbitrary fields', () => {
  assert.deepEqual(Object.keys(PERFORMANCE_CATEGORIES), engineCategories);
  const row = trace(1, { private: 'private-secret', counters: { 'git.spawns': 2, url: 'private-secret' },
    slowOperations: Array.from({ length: 30 }, () => ({ name: 'git.status', category: 'git-local', outcome: 'success', durationMs: 4, prompt: 'private-secret' })) });
  const report = performanceReportFrom(envelope(row, row, trace(2, { invocationId: '../../private-secret' }),
    trace(3, { command: '<img src=x>' }), trace(4, { durationMs: Infinity })));
  assert.equal(report.traces.length, 1);
  assert.equal(report.traces[0].slowOperations.length, 10);
  assert.doesNotMatch(JSON.stringify(report), /private-secret|<img|Infinity/);
  assert.equal(performanceReportFrom(envelope(...Array.from({ length: 100 }, (_, index) => trace(index)))).traces.length, 64);
  assert.throws(() => performanceReportFrom([]), /matching builds/);
});

test('filters are bounded local selections across command, exact action, outcome, temperature and time', () => {
  const report = performanceReportFrom(envelope(trace(1), trace(2, { command: 'phase', outcome: 'timeout', temperature: 'warm' }),
    trace(3, { startedAt: '2026-10-18T01:00:00Z' })));
  assert.equal(filteredPerformanceTraces(report, filters({ search: uuid(100) }), now).length, 3);
  assert.deepEqual(filteredPerformanceTraces(report, filters({ command: 'phase', outcome: 'timeout', temperature: 'warm', hours: '1' }), now).map(row => row.invocationId), [uuid(2)]);
  assert.equal(filteredPerformanceTraces(report, filters({ hours: '24' }), now).length, 2);
  assert.equal(filteredPerformanceTraces(report, filters({ hours: '168' }), now).length, 3);
  assert.equal(filteredPerformanceTraces(report, filters({ search: 'not-present' }), now).length, 0);
  assert.deepEqual(performanceFiltersFrom(filters()), filters());
  for (const bad of [{ outcome: 'approve' }, { hours: '-1' }, { search: 'x'.repeat(101) }, { command: ['phase'] }, { temperature: 'hot' }]) {
    assert.equal(performanceFiltersFrom(filters(bad)), null);
  }
});

test('the page makes elapsed versus service costs, privacy and unknown evidence explicit', () => {
  const html = body();
  assert.match(html, /Where the time went/);
  for (const name of Object.values(PERFORMANCE_CATEGORIES)) assert.ok(html.includes(name));
  assert.match(html, /Concurrent categories \(overlap\)/);
  assert.match(html, /Uninstrumented \/ unattributed/);
  assert.match(html, /durations may overlap/);
  assert.match(html, /Slowest recorded operations/);
  assert.match(html, /git.status/);
  assert.match(html, /Native Copilot internals, tokens and provider cost are unavailable/);
  assert.match(html, /No matching VS Code host observation/);
  assert.match(html, /Capture off/);
  const missing = body({ report: performanceReportFrom(envelope(trace(1, { counters: {}, categories: [], firstFeedbackMs: null, slowOperations: undefined, cpu: {}, memory: {} }))) });
  assert.match(missing, /<strong>Unavailable<\/strong><span>Physical Git spawns/);
  assert.match(missing, /<strong>Unavailable<\/strong><span>Recorded operation calls/);
  assert.match(missing, /Slow-operation details are unavailable/);
});

test('the page distinguishes no capture, no matches, a failed read and partial coverage, and escapes all text', () => {
  assert.match(body({ report: performanceReportFrom(envelope()) }), /No saved command traces/);
  assert.match(body({ filters: filters({ command: 'phase' }) }), /No commands match/);
  assert.match(body({ report: null, loading: true }), /Reading saved performance/);
  const html = body({ error: '<script>private()</script>', repository: '<img src=x onerror=private()>',
    report: performanceReportFrom({ ...envelope(trace(1)), warnings: ['<script>warning()</script>'] }) });
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(body({ report: performanceReportFrom(envelope(trace(1, { coverage: { status: 'partial' }, droppedSpans: 20,
    host: { queueMs: 2, launchCallMs: 3, firstByteMs: 4, processMs: 100, parseMs: 1, postCloseMs: 2 } }))) }), /partial/);
  assert.match(body({ report: performanceReportFrom(envelope(trace(1, { host: { queueMs: 2 } }))) }), /Spawn-call return/);
  const full = page('Performance', body(), "default-src 'none'; script-src 'nonce-unit'", 'unit', PERFORMANCE_REPORT_SCRIPT, { styles: PERFORMANCE_REPORT_STYLE });
  assert.match(full, /<style nonce="unit">/);
  assert.match(full, /<script nonce="unit">/);
  assert.doesNotMatch(full, /https?:\/\/|\sonclick=|\sstyle=/);
});

test('a new panel read is one narrow summary request; local filters and selection require no execution', async () => {
  const requests = [];
  const client = { repository: '/workspace/A', run: async (...args) => { requests.push(args); return envelope(trace(1)); } };
  let changes = 0;
  const reader = new PerformanceReportReader(client, () => changes++);
  await reader.refresh();
  assert.deepEqual(requests[0][0], ['logs', 'performance', '--limit', '64', '--json']);
  assert.ok(requests[0][1] instanceof AbortSignal);
  assert.equal(requests.length, 1);
  assert.equal(changes, 2);
  assert.equal(reader.loading, false);
  filteredPerformanceTraces(reader.report, filters({ command: 'status' }));
  assert.equal(requests.length, 1);
  reader.dispose();
});

test('refresh retires old reads, preserves genuine failure details, and does not hide failures behind an old report', async () => {
  const pending = [], signals = [];
  const client = { repository: '/workspace/A', run: (_args, signal) => { signals.push(signal); const wait = deferred(); pending.push(wait); return wait.promise; } };
  const reader = new PerformanceReportReader(client, () => {});
  const first = reader.refresh(), second = reader.refresh();
  assert.equal(signals[0].aborted, true);
  pending[1].resolve(envelope(trace(2))); await second;
  pending[0].resolve(envelope(trace(1))); await first;
  assert.equal(reader.report.traces[0].invocationId, uuid(2));
  const failed = reader.refresh(); pending[2].reject(new Error('REF_TREE_UNAVAILABLE: exact timeout detail')); await failed;
  assert.equal(reader.report, null);
  assert.equal(reader.error, 'REF_TREE_UNAVAILABLE: exact timeout detail');
  assert.equal(reader.loading, false);
  reader.dispose();
});

test('workspace A → B → A and disposal never admit stale success or failure, even when cancellation is ignored', async () => {
  const pending = [];
  const client = { repository: '/workspace/A', run: () => { const wait = deferred(); pending.push(wait); return wait.promise; } };
  const reader = new PerformanceReportReader(client, () => {});
  const old = reader.refresh();
  client.repository = '/workspace/B'; reader.rebind(client);
  assert.equal(reader.report, null); assert.equal(reader.repository, '/workspace/B');
  client.repository = '/workspace/A'; reader.rebind(client);
  pending[0].resolve(envelope(trace(1))); await old;
  pending[1].reject(new Error('old B failure')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reader.report, null); assert.equal(reader.error, null);
  pending[2].resolve(envelope(trace(3))); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reader.report.traces[0].invocationId, uuid(3));
  const last = reader.refresh(); reader.dispose(); pending[3].resolve(envelope(trace(4))); await last;
  assert.equal(reader.report.traces[0].invocationId, uuid(3));
});

test('the menu and palette report are lazy, pinnable and highlighted under Activity & logs', async () => {
  const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const manifest = JSON.parse(await read('apps/vscode/package.json'));
  assert.equal(manifest.contributes.commands.find(command => command.command === 'singularityFlow.openPerformanceReport').title, 'Singularity Flow: Performance Report');
  const sidebar = await read('apps/vscode/src/views/sidebar.ts');
  assert.match(sidebar, /'activity-tools':[^\n]*'performance'/);
  assert.match(sidebar, /id: 'performance', label: 'Performance'/);
  assert.equal(sidebarDestination('singularityFlow.performanceReport'), 'activity-tools');
  const extension = await read('apps/vscode/src/extension.ts');
  assert.match(extension, /openPerformanceReport': \(\) => performanceViews\(\)/);
  assert.doesNotMatch(extension, /^import(?! type).*from ['"].*performance-report/m);
  assert.match(extension, /performanceViewRuntime\?\.PerformanceReportPanel.repositoryChanged\(client\)/);
  assert.match(await read('apps/vscode/esbuild.mjs'), /'performance-view-runtime': 'src\/performance-view-runtime.ts'/);
});
