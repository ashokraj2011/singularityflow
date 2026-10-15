import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareNativeCopilotTraces, summarizeNativeCopilotTrace } from '../src/native-copilot-efficiency.mjs';

const event = (overrides = {}) => ({ command: 'singularity-flow nextsteps --for-agent --json',
  responseBytes: 100, ...overrides });
const trace = (events = [], overrides = {}) => ({ schemaVersion: 1, events, ...overrides });
const benchmark = { scope: 'command', scenarioId: 'session-open', fixtureSha256: 'a'.repeat(64),
  platform: 'win32', host: 'synthetic-unit-test', temperature: 'warm', sampleCount: 1 };

test('missing timings and counters stay unknown; measured zero remains a measurement', () => {
  const empty = summarizeNativeCopilotTrace(trace([event({ durationMs: null })]));
  assert.deepEqual(empty.toolDurationMs, { samples: 0, total: null, p50: null, p95: null, maximum: null });
  assert.equal(empty.measurements.layers.preHookMs.total, null);
  assert.equal(empty.measurements.operationCounters['git.spawns'].total, null);
  assert.equal(empty.measurements.wallClock.durationMs, null);
  assert.deepEqual(empty.measurements.runtimeModes, { bundled: 0, sources: 0, unknown: 1 });
  const zero = summarizeNativeCopilotTrace(trace([event({ durationMs: 0, timings: { preHookMs: 0 }, counters: { 'git.spawns': 0 } })]));
  assert.equal(zero.toolDurationMs.p95, 0);
  assert.deepEqual(zero.measurements.operationCounters['git.spawns'], { samples: 1, total: 0 });
});

test('p50/p95 use measured samples, layers stay separate, and unrecognized counter names are never retained', () => {
  const events = Array.from({ length: 30 }, (_, index) => event({ durationMs: index + 1,
    timings: { executionMs: index + 1, gitMs: index / 2 },
    counters: { 'git.spawns': 1, 'private-repository-or-command': 900 }, runtimeMode: 'bundled' }));
  const result = summarizeNativeCopilotTrace(trace([...events, event()]));
  assert.equal(result.toolDurationMs.samples, 30);
  assert.equal(result.toolDurationMs.p50, 15);
  assert.equal(result.toolDurationMs.p95, 29);
  assert.equal(result.toolDurationMs.total, 465);
  assert.equal(result.measurements.layers.executionMs.total, 465);
  assert.equal(result.measurements.layers.gitMs.samples, 30);
  assert.equal(result.measurements.layers.startupMs.total, null);
  assert.deepEqual(result.measurements.operationCounters['git.spawns'], { samples: 30, total: 30 });
  assert.equal(JSON.stringify(result).includes('private-repository-or-command'), false);
  assert.equal(result.measurements.runtimeModes.bundled, 30);
});

test('wall-clock duration is explicit and is never inferred from overlapping tool durations', () => {
  const result = summarizeNativeCopilotTrace(trace([event({ durationMs: 2000 }), event({ durationMs: 2000 })], {
    wallClock: { startedAt: '2026-10-15T00:00:00.000Z', completedAt: '2026-10-15T00:00:03.000Z' }
  }));
  assert.equal(result.durationMsSum, 4000);
  assert.deepEqual(result.measurements.wallClock, { durationMs: 3000, source: 'exported-host-trace' });
  for (const wallClock of [null, {}, { startedAt: '2026-10-15', completedAt: '2026-10-16' },
    { startedAt: '2026-10-15T00:00:03Z', completedAt: '2026-10-15T00:00:00Z' }]) {
    assert.throws(() => summarizeNativeCopilotTrace(trace([], { wallClock })), /wallClock/);
  }
});

test('malformed optional measurements and overflowing totals are refused rather than reported as zero', () => {
  for (const extra of [{ durationMs: -1 }, { durationMs: NaN }, { durationMs: Infinity },
    { timings: null }, { timings: [] }, { timings: { startupMs: -1 } }, { timings: { startupMs: '12' } },
    { counters: [] }, { counters: { 'git.spawns': 0.5 } }, { counters: { 'git.spawns': -1 } },
    { runtimeMode: 'guessed' }, { runtimeMode: '__proto__' }, { runtimeMode: {} }, { runtimeMode: [] }]) {
    assert.throws(() => summarizeNativeCopilotTrace(trace([event(extra)])), /Invalid/);
  }
  for (const extra of [{ durationMs: Number.MAX_VALUE }, { timings: { startupMs: Number.MAX_VALUE } },
    { counters: { 'git.spawns': Number.MAX_SAFE_INTEGER } }, { responseBytes: Number.MAX_SAFE_INTEGER },
    { usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 } }]) {
    assert.throws(() => summarizeNativeCopilotTrace(trace([event(extra), event(extra)])), /numeric bound/);
  }
});

test('comparison requires matching explicit fixture, platform, host, temperature and sample count', () => {
  const before = trace([event({ durationMs: 80 }), event({ durationMs: 20 })], { benchmark });
  const after = trace([event({ durationMs: 40 })], { benchmark: { ...benchmark, fixtureSha256: `sha256:${benchmark.fixtureSha256}` } });
  const comparison = compareNativeCopilotTraces(before, after);
  assert.equal(comparison.comparable, true);
  assert.deepEqual(comparison.changes.toolCalls, { before: 2, after: 1, delta: -1, reductionPercent: 50 });
  assert.deepEqual(comparison.changes.toolServiceMs, { before: 100, after: 40, delta: -60, reductionPercent: 60 });
  assert.equal(comparison.changes.wallClockMs, null);
  assert.equal(comparison.billedSavings, null);
  assert.equal(compareNativeCopilotTraces(trace(), trace()).comparable, false);
  for (const invalid of [null, {}, [], { ...benchmark, fixtureSha256: [benchmark.fixtureSha256] },
    { ...benchmark, sampleCount: '1' }, { ...benchmark, sampleCount: 0 }, { ...benchmark, host: '../private' }]) {
    const rejected = compareNativeCopilotTraces(before, { ...after, benchmark: invalid });
    assert.equal(rejected.comparable, false);
    assert.equal(rejected.changes, null);
  }
  for (const [key, value] of Object.entries({ scope: 'story', scenarioId: 'other', fixtureSha256: 'b'.repeat(64),
    platform: 'darwin', host: 'other-host', temperature: 'cold', sampleCount: 2 })) {
    const rejected = compareNativeCopilotTraces(before, { ...after, benchmark: { ...benchmark, [key]: value } });
    assert.equal(rejected.comparable, false, key);
    assert.equal(rejected.changes, null, key);
    assert.ok(rejected.reasons.includes(`benchmark.mismatch.${key}`), key);
  }
});

test('Story comparisons require matching complete phase journeys, not just a completion label', () => {
  const before = trace([event()], { benchmark: { ...benchmark, scope: 'story' }, workflow: 'custom-loop',
    phaseOrder: ['intake', 'test', 'repair', 'close'], completedPhases: ['intake', 'test', 'repair', 'close'], lifecycleStatus: 'completed' });
  assert.equal(compareNativeCopilotTraces(before, structuredClone(before)).comparable, true);
  for (const changed of [{ completedPhases: ['intake'] }, { lifecycleStatus: 'in_progress' }, { workflow: 'another' },
    { phaseOrder: ['intake', 'close'], completedPhases: ['intake', 'close'] }]) {
    const result = compareNativeCopilotTraces(before, { ...before, ...changed });
    assert.equal(result.comparable, false);
    assert.equal(result.changes, null);
  }
});

test('partial service timings cannot claim a complete service reduction, and a zero baseline has no percentage', () => {
  const before = trace([event({ durationMs: 0 })], { benchmark });
  const after = trace([event()], { benchmark });
  assert.equal(compareNativeCopilotTraces(before, after).changes.toolServiceMs, null);
  assert.equal(compareNativeCopilotTraces(trace([], { benchmark }), after).changes.toolCalls.reductionPercent, null);
});

test('the CLI compares selected bounded traces and refuses an unpaired comparison', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-comparison-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = path.join(directory, 'before.json'), after = path.join(directory, 'after.json');
  await writeFile(before, JSON.stringify(trace([event()], { benchmark })));
  await writeFile(after, JSON.stringify(trace([event(), event()], { benchmark })));
  const script = fileURLToPath(new URL('../scripts/native-copilot-audit.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--trace', before, '--compare', after], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.comparison.comparable, true);
  assert.equal(report.comparison.changes.toolCalls.reductionPercent, -100);
  assert.equal(report.entryStrategies['session-open'], 1);
  await writeFile(after, JSON.stringify(trace([event()], { benchmark: { ...benchmark, platform: 'darwin' } })));
  const mismatched = spawnSync(process.execPath, [script, '--trace', before, '--compare', after], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(mismatched.status, 0);
  assert.equal(JSON.parse(mismatched.stdout).comparison.comparable, false);
  for (const args of [['--compare', after], ['--trace', before, '--compare'], ['--trace', before, '--trace', after]]) {
    const invalid = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, '');
  }
});
