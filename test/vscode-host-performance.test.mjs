import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildHostPerformanceReport, summarizeHostMetric } from '../src/vscode-host-performance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sample(scenario, overrides = {}) {
  const successfulCounters = {
    cliProcessesStarted: 1, cliProcessesCompleted: 1, cliProcessesSucceeded: 1,
    cliProcessesFailed: 0, cliProcessesConcurrent: 0, cliProcessesMaximumConcurrent: 1,
    backgroundTasksStarted: 0, backgroundTasksCompleted: 0,
    backgroundTasksConcurrent: 0, backgroundTasksMaximumConcurrent: 0,
    storeEvents: 0, snapshotEvents: 0, sidebarRenders: 0
  };
  return {
    schemaVersion: 1,
    kind: 'sflow-vscode-extension-host-sample',
    scenario,
    vscode: { version: '1.90.3', appHost: 'desktop' },
    extension: { version: '0.9.0', activeBeforeRequest: false },
    cachePersisted: true,
    activation: {
      viewOpenAndActivationMs: 120,
      marksMs: {
        activationComplete: 100,
        confirmedFirstPaint: 80,
        ...(scenario === 'warm' ? { cachedFirstPaint: 20 } : {})
      },
      counters: { ...successfulCounters, storeEvents: 2, snapshotEvents: 1, sidebarRenders: 2 },
      childMemory: { status: 'measured-linux-proc', peakRssBytes: 10_000 },
      eventLoop: { maxDelayMs: 12, meanDelayMs: 10, p95DelayMs: 11 }
    },
    unchangedRefresh: { durationMs: 30, counters: { ...successfulCounters }, childMemory: { status: 'measured-linux-proc', peakRssBytes: 9_000 }, eventLoop: { maxDelayMs: 13, meanDelayMs: 10, p95DelayMs: 11 } },
    changedRefresh: { durationMs: 40, counters: { ...successfulCounters }, childMemory: { status: 'measured-linux-proc', peakRssBytes: 11_000 }, eventLoop: { maxDelayMs: 14, meanDelayMs: 10, p95DelayMs: 11 } },
    watcherStorm: { durationMs: 900, eventsWritten: 100, counters: {
      ...successfulCounters, cliProcessesStarted: 2, cliProcessesCompleted: 2,
      cliProcessesSucceeded: 2, sidebarRenders: 2
    }, childMemory: { status: 'measured-linux-proc', peakRssBytes: 12_000 }, eventLoop: { maxDelayMs: 15, meanDelayMs: 10, p95DelayMs: 11 } },
    webviewOpening: { durationMs: 25, counters: { ...successfulCounters }, childMemory: { status: 'measured-linux-proc', peakRssBytes: 8_000 }, eventLoop: { maxDelayMs: 16, meanDelayMs: 10, p95DelayMs: 11 } },
    cachePersistence: { durationMs: 8, counters: { ...successfulCounters }, childMemory: { status: 'measured-linux-proc', peakRssBytes: 7_000 }, eventLoop: { maxDelayMs: 9, meanDelayMs: 8, p95DelayMs: 9 } },
    steadyStateEventLoop: { maxDelayMs: 18, meanDelayMs: 10, p95DelayMs: 11 },
    eventLoop: { maxDelayMs: 12, meanDelayMs: 10, p95DelayMs: 11 },
    final: { extensionHostRssBytes: 100_000, cliProcessesConcurrent: 0, backgroundTasksConcurrent: 0 },
    ...overrides
  };
}

const budgets = {
  schemaVersion: 1,
  minimum: {
    samples: 1,
    budgets: {
      activationCompleteMs: { p95: 750 },
      cachedFirstPaintMs: { p95: 250 },
      watcherStormCliProcesses: { maximum: 2 }
    }
  }
};

test('host metrics use nearest-rank p50 and p95 without dropping a slow tail', () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.deepEqual(summarizeHostMetric(values), {
    samples: 20, minimum: 1, p50: 10, p95: 19, maximum: 20
  });
});

test('real-host cold/warm samples produce bounded aggregate metrics without retaining repository data', () => {
  const report = buildHostPerformanceReport({
    profile: 'minimum', pairs: [{ cold: sample('cold'), warm: sample('warm') }], budgets, enforce: true
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.protocol.host, 'real-vscode-extension-host');
  assert.equal(report.metrics.cachedFirstPaintMs.p95, 20);
  assert.equal(report.metrics.coldActivationCompleteMs.samples, 1);
  assert.equal(report.metrics.activationCompleteMs.samples, 2);
  assert.equal(report.metrics.peakChildRssBytes.maximum, 12_000);
  assert.equal(report.metrics.activationEventLoopMaxDelayMs.maximum, 12);
  assert.equal(report.metrics.steadyStateEventLoopMaxDelayMs.maximum, 18,
    'the continuous steady-state envelope includes gaps between narrower surface probes');
  assert.equal(report.protocol.questionsOrContentCaptured, false);
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /repositoryPath|work[-_ ]?id|identity|artifact|fixture\/path/i);
});

test('host benchmark refuses a false warm-cache claim and a synthetic tail regression', () => {
  const warm = sample('warm');
  delete warm.activation.marksMs.cachedFirstPaint;
  const cold = sample('cold');
  cold.activation.marksMs.activationComplete = 751;
  const report = buildHostPerformanceReport({
    profile: 'minimum', pairs: [{ cold, warm }], budgets, enforce: true
  });
  assert.equal(report.status, 'failed');
  assert.ok(report.failures.includes('pair-1:warm-cache-paint-missing'));
  assert.ok(report.failures.includes('activationCompleteMs:p95>750'));
  assert.ok(report.failures.includes('cachedFirstPaintMs:unavailable'));
});

test('host benchmark refuses fast failed CLI samples', () => {
  const warm = sample('warm');
  warm.unchangedRefresh.counters.cliProcessesSucceeded = 0;
  warm.unchangedRefresh.counters.cliProcessesFailed = 1;
  const report = buildHostPerformanceReport({
    profile: 'minimum', pairs: [{ cold: sample('cold'), warm }], budgets, enforce: false
  });
  assert.equal(report.status, 'incomplete');
  assert.ok(report.failures.includes('pair-1:warm-unchangedRefresh-cli-failed'));
});

test('the benchmark launcher uses VS Code extensionTestsPath and fails closed without a real host', async () => {
  const [launcher, runner, probe] = await Promise.all([
    readFile(path.join(root, 'scripts/vscode-host-benchmark.mjs'), 'utf8'),
    readFile(path.join(root, 'apps/vscode/test/host-performance-runner.cjs'), 'utf8'),
    readFile(path.join(root, 'apps/vscode/src/host-performance.ts'), 'utf8')
  ]);
  assert.match(launcher, /--extensionTestsPath=/);
  assert.match(launcher, /singularityFlow\.cliPath/);
  assert.match(launcher, /A real VS Code CLI was not found/);
  assert.doesNotMatch(launcher, /stubVscode|simulated-extension-host/);
  assert.match(runner, /workbench\.view\.extension\.singularityFlowNavigator/);
  assert.match(runner, /monitorEventLoopDelay/);
  assert.match(runner, /steadyStateEventLoop/);
  assert.match(probe, /process\.platform === 'linux'/);
  assert.match(probe, /cliProcessesFailed/);
  assert.match(probe, /trackHostBackgroundTask/);
  assert.match(probe, /\/proc\/\$\{pid\}\/status/);
});
