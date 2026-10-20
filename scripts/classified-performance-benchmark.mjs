/** Local fixture only: paired capture overhead, not a claim about native Copilot or cold disks. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createWarmReadFixture } from './warm-read-fixture.mjs';
import { readPerformanceReport } from '../src/performance-trace-store.mjs';

const samples = Number(process.argv.find(arg => arg.startsWith('--samples='))?.split('=')[1] ?? 5);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20) throw new Error('Use --samples=1..20.');
const f = await createWarmReadFixture();
const rows = [];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (const args of [['logs', 'path'], ['status', 'PERF-001', '--json'], ['nextsteps', 'PERF-001', '--json']]) {
    const observed = { disabled: [], enabled: [] }, calls = { disabled: [], enabled: [] };
    let finalAction;
    // One unmeasured initialization; each measured invocation is nevertheless a fresh Node child.
    spawnSync(process.execPath, [f.cli, ...args], { cwd: f.repository, env: f.env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    for (let sample = 0; sample < samples; sample++) {
      for (const mode of sample % 2 ? ['enabled', 'disabled'] : ['disabled', 'enabled']) {
        const action = randomUUID(), started = process.hrtime.bigint();
        const result = spawnSync(process.execPath, [f.cli, ...args, '--timings'], { cwd: f.repository, encoding: 'utf8',
          timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...f.env,
            SINGULARITY_FLOW_DISABLE_TIMING_LOG: '0', SINGULARITY_FLOW_PERF_TRACE: mode === 'enabled' ? '1' : '0',
            SINGULARITY_FLOW_PERF_ACTION_ID: action, SINGULARITY_FLOW_PERF_TEMPERATURE: 'unknown' } });
        if (result.status !== 0) throw new Error(`Fixture ${args[0]} failed (${result.status}): ${result.stderr}`);
        observed[mode].push(Number(process.hrtime.bigint() - started) / 1e6);
        calls[mode].push(Number(/(?:^|\s)git\.spawns=(\d+)/u.exec(result.stderr)?.[1] ?? 0));
        if (mode === 'enabled') finalAction = action;
      }
    }
    const report = await readPerformanceReport(path.join(f.repository, '.git', 'singularity-flow', 'dx'), { actionId: finalAction });
    const trace = report.traces[0];
    rows.push({ command: args[0], samples, disabledMedianMs: median(observed.disabled), enabledMedianMs: median(observed.enabled),
      observedOverheadMs: median(observed.enabled) - median(observed.disabled),
      physicalGitSpawns: { disabled: median(calls.disabled), enabled: median(calls.enabled) },
      capturedSpans: trace?.spanCount ?? null, categories: trace?.categories.filter(row => row.calls || row.wallMs),
      overlapMs: trace?.overlapMs, unattributedMs: trace?.unattributedMs });
  }
  console.log(JSON.stringify({ kind: 'sflow-classified-performance-local-qualification', platform: process.platform,
    runtime: process.version, mode: 'fresh-node-process-with-warm-filesystem', rows,
    limitations: ['Synthetic local fixture, not representative end-to-end host qualification.', 'Not native Copilot latency/token qualification.',
      'No OS page-cache flush; paired medians include normal local timing persistence.', 'No real provider requests or remote Git operations.'] }, null, 2));
} finally { await f.cleanup(); }
