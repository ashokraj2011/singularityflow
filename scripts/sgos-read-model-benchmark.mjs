#!/usr/bin/env node
/**
 * Content-free SGOS read-model benchmark.
 *
 * The fixture contains only generated identifiers and state labels. The report exposes aggregate
 * timing, byte, and row counts; it never emits Process, task, path, prompt, identity, or record
 * digests. No store, model, network, lifecycle command, or telemetry exporter is invoked.
 */
import { performance } from 'node:perf_hooks';

import { projectSgosCommandCenter } from '../src/sgos/command-center.mjs';
import {
  projectSgosViewCatalog, SGOS_PROJECTED_VIEW_TYPES
} from '../src/sgos/projection.mjs';

const userArguments = process.argv.slice(2);
const sampleArgument = userArguments.find((argument) => argument.startsWith('--samples='));
const samples = Number(sampleArgument?.slice('--samples='.length) ?? 20);
const enforce = userArguments.includes('--enforce');
const unknown = userArguments.filter((argument) => (
  argument !== '--enforce' && !argument.startsWith('--samples=')
));
if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
  throw new Error('--samples must be an integer from 1 to 100');
}

const PROFILES = Object.freeze([
  Object.freeze({ id: 'single-task', tasks: 1, totalP95Milliseconds: 50, maximumBytes: 256 * 1024 }),
  Object.freeze({ id: 'review-scale', tasks: 200, totalP95Milliseconds: 250, maximumBytes: 2 * 1024 * 1024 }),
  Object.freeze({ id: 'installed-ceiling', tasks: 2_000, totalP95Milliseconds: 1_500, maximumBytes: 8 * 1024 * 1024 })
]);

const HASH = (character) => `sha256:${character.repeat(64)}`;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function distribution(values) {
  return {
    minimum: Number(Math.min(...values).toFixed(3)),
    median: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    maximum: Number(Math.max(...values).toFixed(3))
  };
}

function fixture(taskCount) {
  const taskInstances = {};
  for (let index = 0; index < taskCount; index += 1) {
    const suffix = String(index + 1).padStart(4, '0');
    const taskInstanceId = `TASK-${suffix}`;
    taskInstances[taskInstanceId] = {
      taskInstanceId,
      taskTemplateId: `task-${suffix}`,
      state: index % 5 === 0 ? 'succeeded' : index % 5 === 1 ? 'ready' : 'waiting',
      predecessorTaskInstanceIds: index === 0 ? [] : [`TASK-${String(index).padStart(4, '0')}`],
      inputRefs: [], outputRefs: [], attemptIds: [],
      receiptSha256: index % 5 === 0 ? HASH('8') : null,
      invalidatedBy: null, revision: 1
    };
  }
  return {
    schemaVersion: 1,
    kind: 'gvm-process',
    processId: 'PROC-BENCHMARK',
    processRevision: 1,
    processSha256: HASH('1'),
    programSha256: HASH('2'),
    policySnapshotSha256: HASH('3'),
    processBindingSha256: HASH('4'),
    taskContractSha256: HASH('5'),
    status: 'running',
    taskInstances,
    activeExecutions: [], activeLeases: [], openHumanRequests: [],
    currentCheckpointSha256: HASH('6'), controlEventSha256: HASH('7'),
    recordIndexSha256: HASH('9'),
    authorityBinding: {
      kind: 'repository', subjectId: 'benchmark', branch: 'benchmark',
      baselineRevision: '1'.repeat(40)
    },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function rowsIn(catalog) {
  return catalog.reduce((total, object) => (
    total + (object.view.schema?.['x-sgos-render']?.rows?.length ?? 0)
  ), 0);
}

function measure(profile) {
  const source = fixture(profile.tasks);
  // Warm module/JIT paths without including warmup in the declared sample count.
  projectSgosViewCatalog(source);
  projectSgosCommandCenter([source]);
  const catalogDurations = [];
  const centerDurations = [];
  const totalDurations = [];
  const cpuDurations = [];
  let catalog;
  let center;
  let serializedBytes = 0;
  let expectedCatalog = null;
  let expectedCenter = null;
  for (let index = 0; index < samples; index += 1) {
    const cpuStarted = process.cpuUsage();
    const totalStartedAt = performance.now();
    const catalogStartedAt = performance.now();
    catalog = projectSgosViewCatalog(source);
    catalogDurations.push(performance.now() - catalogStartedAt);
    const centerStartedAt = performance.now();
    center = projectSgosCommandCenter([source]);
    centerDurations.push(performance.now() - centerStartedAt);
    totalDurations.push(performance.now() - totalStartedAt);
    const cpu = process.cpuUsage(cpuStarted);
    cpuDurations.push((cpu.user + cpu.system) / 1_000);
    const serializedCatalog = JSON.stringify(catalog);
    const serializedCenter = JSON.stringify(center);
    if (expectedCatalog == null) {
      expectedCatalog = serializedCatalog;
      expectedCenter = serializedCenter;
      serializedBytes = Buffer.byteLength(serializedCatalog) + Buffer.byteLength(serializedCenter);
    } else if (serializedCatalog !== expectedCatalog || serializedCenter !== expectedCenter) {
      throw new Error(`SGOS read-model projection was nondeterministic for '${profile.id}'.`);
    }
  }
  const timing = {
    catalog: distribution(catalogDurations),
    commandCenter: distribution(centerDurations),
    total: distribution(totalDurations),
    cpu: distribution(cpuDurations)
  };
  const failures = [
    timing.total.p95 > profile.totalP95Milliseconds
      ? `total-p95>${profile.totalP95Milliseconds}ms` : null,
    serializedBytes > profile.maximumBytes
      ? `serialized-bytes>${profile.maximumBytes}` : null,
    catalog.length !== SGOS_PROJECTED_VIEW_TYPES.length
      ? 'view-catalog-incomplete' : null,
    center.views.length !== SGOS_PROJECTED_VIEW_TYPES.length
      ? 'command-center-view-catalog-incomplete' : null
  ].filter(Boolean);
  return {
    profile: profile.id,
    tasks: profile.tasks,
    requestedSamples: samples,
    completedSamples: samples,
    views: SGOS_PROJECTED_VIEW_TYPES.length,
    projectedRows: rowsIn(catalog),
    serializedBytes,
    timingsMilliseconds: timing,
    budgets: {
      totalP95Milliseconds: profile.totalP95Milliseconds,
      maximumBytes: profile.maximumBytes
    },
    outcome: failures.length ? 'budget-exceeded' : 'passed',
    failures
  };
}

const profiles = PROFILES.map(measure);
const failures = profiles.flatMap((profile) => profile.failures.map((failure) => ({
  profile: profile.profile, failure
})));
const report = {
  schema: 'sflow-sgos-read-model-benchmark/v1',
  assurance: 'content-free-local-measurement',
  authoritative: false,
  lifecycleGate: false,
  externalTelemetrySent: false,
  modelInvocations: 0,
  networkRequests: 0,
  platform: process.platform,
  architecture: process.arch,
  nodeMajor: Number(process.versions.node.split('.')[0]),
  profiles,
  outcome: failures.length ? 'budget-exceeded' : 'passed',
  failures,
  contentExcluded: [
    'process-id', 'task-id', 'record-digest', 'repository-path', 'file-path', 'source-bytes',
    'prompt', 'response', 'identity', 'work-id', 'telemetry-destination'
  ]
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (enforce && failures.length) process.exitCode = 1;
