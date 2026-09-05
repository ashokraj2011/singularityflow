#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  buildTestExecutionReceipt, replayLocalJunitObservation
} from '../src/code-delivery-tests.mjs';
import { observeJunit5SurefireIdentities } from '../src/wel-junit5.mjs';

const sampleArgument = process.argv.find((argument) => argument.startsWith('--samples='));
const samples = Number(sampleArgument?.slice('--samples='.length) ?? 12);
if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
  throw new Error('--samples must be an integer from 1 to 100');
}

const command = {
  id: 'wel-benchmark-junit', kind: 'test', argv: ['mvn', 'test'], workingDirectory: '.',
  affectedRoots: ['.'], modelPolicy: 'never',
  result: { adapter: 'junit-xml', path: 'target/surefire-reports', minimumDiscovered: 1 }
};
const policy = {
  mode: 'observe', adapter: 'junit5-surefire-v1', requiredWitnessTypes: ['test'],
  evidenceTier: 'testcase-local-observed'
};
const rawReport = Buffer.from([
  '<testsuite name="WelBenchmarkTest" tests="1" failures="0" errors="0" skipped="0">',
  '<testcase classname="benchmark.WelBenchmarkTest" name="observesExactIdentity" time="0.001"/>',
  '</testsuite>'
].join(''), 'utf8');

function parsedReport(replay) {
  return {
    adapter: 'junit-xml', tests: replay.tests,
    testcaseObservation: replay.testcaseObservation,
    result: { path: 'target/surefire-reports', ...replay.result },
    rawReports: [], minimumDiscovered: 1, minimumPassed: 1
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-benchmark-'));
try {
  const sourcePath = path.join(root, 'src/test/java/benchmark/WelBenchmarkTest.java');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, [
    'package benchmark;',
    'import org.junit.jupiter.api.Tag;',
    'import org.junit.jupiter.api.Test;',
    'class WelBenchmarkTest {',
    '  @Test @Tag("sflow-ac:BENCH:AC-001")',
    '  void observesExactIdentity() {}',
    '}',
    ''
  ].join('\n'));
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'WEL Benchmark'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'wel-benchmark@example.invalid'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/wel/benchmark.git'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'benchmark fixture'], { cwd: root, stdio: 'ignore' });

  const durations = [];
  const reportDurations = [];
  const projectionDurations = [];
  const cpuDurations = [];
  let catalogBytes = 0;
  let receiptBytes = 0;
  let outcome = 'unavailable';
  let unavailableCode = null;
  for (let index = 0; index < samples; index += 1) {
    const cpuStarted = process.cpuUsage();
    const reportStartedAt = performance.now();
    const replay = replayLocalJunitObservation([{ contents: rawReport }]);
    reportDurations.push(performance.now() - reportStartedAt);
    const parsed = parsedReport(replay);
    const startedAt = performance.now();
    const observation = await observeJunit5SurefireIdentities(root, command, parsed, policy);
    durations.push(performance.now() - startedAt);
    if (observation.exact !== true) {
      unavailableCode = observation.gaps?.[0] ?? 'WEL_EXACT_OBSERVATION_UNAVAILABLE';
      break;
    }
    outcome = 'observed';
    catalogBytes = Buffer.byteLength(JSON.stringify(observation.catalog), 'utf8');
    const projectionStartedAt = performance.now();
    const receipt = buildTestExecutionReceipt(command, {
      status: 'passed', exitCode: 0, stderr: '', sourceCommit: 'b'.repeat(40),
      sourceTreeSha256: 'c'.repeat(64), startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString()
    }, parsed, { testcasePolicy: policy, exactTestcaseObservation: observation });
    projectionDurations.push(performance.now() - projectionStartedAt);
    receiptBytes = Buffer.byteLength(JSON.stringify(receipt), 'utf8');
    const cpu = process.cpuUsage(cpuStarted);
    cpuDurations.push((cpu.user + cpu.system) / 1_000);
  }
  const completed = outcome === 'observed' ? durations.length : 0;
  const report = {
    schema: 'sflow-wel-benchmark/v2',
    assurance: 'content-free-local-measurement',
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    requestedSamples: samples,
    completedSamples: completed,
    outcome,
    unavailableCode,
    parserMilliseconds: completed ? {
      minimum: Number(Math.min(...durations).toFixed(3)),
      median: Number(percentile(durations, 0.5).toFixed(3)),
      p95: Number(percentile(durations, 0.95).toFixed(3)),
      maximum: Number(Math.max(...durations).toFixed(3))
    } : null,
    reportIngestionMilliseconds: completed ? {
      minimum: Number(Math.min(...reportDurations).toFixed(3)),
      median: Number(percentile(reportDurations, 0.5).toFixed(3)),
      p95: Number(percentile(reportDurations, 0.95).toFixed(3)),
      maximum: Number(Math.max(...reportDurations).toFixed(3))
    } : null,
    receiptProjectionMilliseconds: completed ? {
      minimum: Number(Math.min(...projectionDurations).toFixed(3)),
      median: Number(percentile(projectionDurations, 0.5).toFixed(3)),
      p95: Number(percentile(projectionDurations, 0.95).toFixed(3)),
      maximum: Number(Math.max(...projectionDurations).toFixed(3))
    } : null,
    cpuMilliseconds: completed ? {
      median: Number(percentile(cpuDurations, 0.5).toFixed(3)),
      p95: Number(percentile(cpuDurations, 0.95).toFixed(3))
    } : null,
    catalogBytes,
    receiptBytes,
    rawReportBytes: rawReport.length,
    estimatedDurableBytesPerExecution: outcome === 'observed'
      ? receiptBytes + rawReport.length : 0,
    fixtureOutcomes: {
      cases: 1,
      exactStatic: outcome === 'observed' ? 1 : 0,
      inexact: outcome === 'observed' ? 0 : 1,
      falseExact: 0
    },
    measurementCapabilities: [
      'source-catalog', 'report-ingestion', 'receipt-projection', 'durable-storage-estimate'
    ],
    contentExcluded: ['repository-path', 'origin-url', 'work-id', 'git-identity', 'clause-text', 'test-body']
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
