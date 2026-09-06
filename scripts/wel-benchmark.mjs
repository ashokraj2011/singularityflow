#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  buildTestExecutionReceipt, replayLocalJunitObservation
} from '../src/code-delivery-tests.mjs';
import { ensureConfigurationBranch } from '../src/configuration-branch.mjs';
import { recordContextPacketTelemetry } from '../src/context-packet-telemetry.mjs';
import { contextXray } from '../src/context-xray.mjs';
import { manualStorySource, startStory } from '../src/story-start.mjs';
import { observeJunit5SurefireIdentities } from '../src/wel-junit5.mjs';
import {
  validateWelBenchmarkEvidence, WEL_BENCHMARK_ASSURANCE, WEL_BENCHMARK_CAPABILITIES,
  WEL_BENCHMARK_EXCLUDED_CONTENT, WEL_BENCHMARK_SCHEMA
} from '../src/wel-benchmark-evidence.mjs';

const sampleArgument = process.argv.find((argument) => argument.startsWith('--samples='));
const samples = Number(sampleArgument?.slice('--samples='.length) ?? 12);
if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
  throw new Error('--samples must be an integer from 1 to 100');
}
const storySampleArgument = process.argv.find((argument) => argument.startsWith('--story-samples='));
const storySamples = Number(storySampleArgument?.slice('--story-samples='.length)
  ?? Math.min(samples, 3));
if (!Number.isInteger(storySamples) || storySamples < 1 || storySamples > 30) {
  throw new Error('--story-samples must be an integer from 1 to 30');
}
const outputArgument = process.argv.find((argument) => argument.startsWith('--out='));
const outputPath = outputArgument?.slice('--out='.length)
  || process.env.SINGULARITY_FLOW_WEL_BENCHMARK_OUT
  || null;
if (outputPath != null && (!path.isAbsolute(outputPath) || outputPath.includes('\0'))) {
  throw new Error('WEL benchmark output must be an absolute path.');
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

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

const benchmarkWorkId = 'WEL-BENCH-LOCAL';

function contextWorkflow() {
  return {
    workItem: { id: benchmarkWorkId, title: 'Local benchmark', workType: 'story' },
    status: 'active', currentPhase: 'implementation', phaseOrder: ['implementation'],
    phases: {
      implementation: {
        id: 'implementation', generation: 1, usage: [{
          status: 'estimated', source: 'benchmark-fixture', provider: null,
          requestedModel: null, resolvedModel: null, resolvedModelAssurance: 'unavailable',
          inputTokens: null, outputTokens: null, cachedInputTokens: null,
          cacheWriteInputTokens: null, providerCost: null
        }]
      }
    }
  };
}

function contextPacket() {
  return {
    packetId: 'ctx-welbenchmark00000001',
    binding: {
      workId: benchmarkWorkId, workType: 'story', phase: 'implementation', generation: 1,
      sourceRevision: 'b'.repeat(40), flightPlanId: null
    },
    budget: {
      includedContentBytes: 512, estimatedInputTokens: 128,
      estimationMethod: 'utf8-bytes-divided-by-four'
    },
    omissions: [{ count: 1, omissionClasses: { budget: 1 } }],
    unavailable: [],
    observation: { rawBytes: 768, includedBytes: 512 },
    contextManifest: { cacheKey: 'wel-benchmark-context', itemDigests: ['d'.repeat(64)] },
    items: [{
      itemId: 'benchmark-structural-item', bytes: 512, estimatedTokens: 128,
      mandatory: true, cacheClass: 'stable'
    }],
    tokenEconomy: { mode: 'observe', profile: 'balanced', configurationDigest: 'e'.repeat(64) }
  };
}

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

function git(root, ...arguments_) {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim();
}

async function storyBenchmarkRepository({ publish = 'off' } = {}) {
  const storyRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-story-benchmark-'));
  const storyRemote = `${storyRoot}.git`;
  git(storyRoot, 'init', '-q', '-b', 'main');
  git(storyRoot, 'config', 'user.name', 'WEL Benchmark');
  git(storyRoot, 'config', 'user.email', 'wel-benchmark@example.invalid');
  await writeFile(path.join(storyRoot, 'README.md'), '# Local benchmark fixture\n');
  execFileSync(process.execPath, [cli, 'init'], {
    cwd: storyRoot, stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'WEL Benchmark' }
  });
  const workflowPath = path.join(storyRoot, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.git.publish = publish;
  workflow.worldModel.grounding = 'off';
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(storyRoot, 'add', '.');
  git(storyRoot, 'commit', '-qm', 'benchmark fixture');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', storyRemote], {
    stdio: 'ignore'
  });
  git(storyRoot, 'remote', 'add', 'origin', storyRemote);
  git(storyRoot, 'push', '-q', '-u', 'origin', 'main');
  await ensureConfigurationBranch(storyRemote, { sourceBranch: 'main' });
  return { storyRoot, storyRemote };
}

function storySource(workId, description) {
  return manualStorySource(workId, {
    title: 'Local latency fixture',
    description,
    desiredOutcome: 'Produce content-free local latency evidence.',
    acceptanceCriteria: 'A governed Story branch is created.'
  });
}

async function measureStoryStarts(count) {
  const { storyRoot, storyRemote } = await storyBenchmarkRepository();
  const durations = [];
  let workflowBytes = 0;
  try {
    for (let index = 0; index < count; index += 1) {
      if (index) git(storyRoot, 'switch', '-q', 'main');
      const workId = `WEL-PERF-${String(index + 1).padStart(3, '0')}`;
      const startedAt = performance.now();
      const started = await startStory(storyRoot, {
        id: workId,
        source: storySource(workId,
          'Measure the governed Story-start path without product content.'),
        workType: 'feature', agent: 'product-owner', baseBranch: 'main',
        astWarmLauncher: () => ({ pid: 0 })
      });
      durations.push(performance.now() - startedAt);
      workflowBytes = Buffer.byteLength(JSON.stringify(started.workflow), 'utf8');
    }
    return { durations, workflowBytes };
  } finally {
    await Promise.all([
      rm(storyRoot, { recursive: true, force: true }),
      rm(storyRemote, { recursive: true, force: true })
    ]);
  }
}

async function measureStoryPushRecovery() {
  const { storyRoot, storyRemote } = await storyBenchmarkRepository({ publish: 'required' });
  const rejectionHook = path.join(storyRemote, 'hooks', 'pre-receive');
  let hookInstalled = false;
  try {
    const workId = 'WEL-RECOVERY-LOCAL';
    const failureStartedAt = performance.now();
    let failure = null;
    try {
      await startStory(storyRoot, {
        id: workId,
        source: storySource(workId,
          'Measure exact recovery after a post-preflight local push failure.'),
        workType: 'feature', agent: 'product-owner', baseBranch: 'main',
        astWarmLauncher: () => ({ pid: 0 }),
        afterPublicationPreflight: async () => {
          await writeFile(rejectionHook,
            '#!/bin/sh\necho wel-benchmark-post-preflight-rejection >&2\nexit 1\n');
          await chmod(rejectionHook, 0o755);
          hookInstalled = true;
        }
      });
    } catch (error) {
      failure = error;
    }
    const failureMilliseconds = performance.now() - failureStartedAt;
    if (!failure || !hookInstalled) {
      throw new Error('Story publication failure exercise did not reach the post-preflight boundary.');
    }
    await rm(rejectionHook, { force: true });
    hookInstalled = false;
    const recoveryStartedAt = performance.now();
    try {
      execFileSync(process.execPath, [cli, 'sync', '--json'], {
        cwd: storyRoot, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env, NODE_ENV: 'test',
          SINGULARITY_FLOW_TEST_IDENTITY: 'WEL Benchmark'
        }
      });
    } catch (error) {
      const diagnostic = String(error?.stderr ?? '').trim().split(/\r?\n/).at(-1);
      throw new Error(`Story publication recovery command failed${diagnostic ? `: ${diagnostic}` : '.'}`,
        { cause: error });
    }
    const recoveryMilliseconds = performance.now() - recoveryStartedAt;
    const localCommit = git(storyRoot, 'rev-parse', 'HEAD');
    const remoteCommit = git(storyRoot, 'ls-remote', 'origin', `refs/heads/${workId}`)
      .split(/\s+/)[0] ?? '';
    if (!remoteCommit || remoteCommit !== localCommit) {
      throw new Error('Story publication recovery did not publish the exact retained commit.');
    }
    return {
      outcome: 'recovered',
      failureCode: /^[A-Z][A-Z0-9_]{2,127}$/.test(failure.code ?? '')
        ? failure.code : 'STORY_PUBLICATION_FAILED',
      failureMilliseconds,
      recoveryMilliseconds,
      exactRetainedCommitPublished: true
    };
  } finally {
    if (hookInstalled) await rm(rejectionHook, { force: true }).catch(() => {});
    await Promise.all([
      rm(storyRoot, { recursive: true, force: true }),
      rm(storyRemote, { recursive: true, force: true })
    ]);
  }
}

async function measureStoryOfflineRecovery() {
  const { storyRoot, storyRemote } = await storyBenchmarkRepository({ publish: 'required' });
  const unavailableRemote = `${storyRemote}.unavailable`;
  let remoteUnavailable = false;
  let cloneRoot = null;
  try {
    const workId = 'WEL-OFFLINE-LOCAL';
    const failureStartedAt = performance.now();
    let failure = null;
    try {
      await startStory(storyRoot, {
        id: workId,
        source: storySource(workId,
          'Measure exact recovery after the publication authority becomes unavailable.'),
        workType: 'feature', agent: 'product-owner', baseBranch: 'main',
        astWarmLauncher: () => ({ pid: 0 }),
        afterPublicationPreflight: async () => {
          await rename(storyRemote, unavailableRemote);
          remoteUnavailable = true;
        }
      });
    } catch (error) {
      failure = error;
    }
    const failureMilliseconds = performance.now() - failureStartedAt;
    if (!failure || !remoteUnavailable) {
      throw new Error('Offline Story publication exercise did not reach the post-preflight boundary.');
    }
    await rename(unavailableRemote, storyRemote);
    remoteUnavailable = false;
    const retainedCommit = git(storyRoot, 'rev-parse', 'HEAD');
    const recoveryStartedAt = performance.now();
    execFileSync(process.execPath, [cli, 'sync', workId, '--json'], {
      cwd: storyRoot, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, NODE_ENV: 'test',
        SINGULARITY_FLOW_TEST_IDENTITY: 'WEL Benchmark'
      }
    });
    const recoveryMilliseconds = performance.now() - recoveryStartedAt;
    const remoteCommit = git(storyRoot, 'ls-remote', 'origin', `refs/heads/${workId}`)
      .split(/\s+/)[0] ?? '';
    if (!remoteCommit || remoteCommit !== retainedCommit) {
      throw new Error('Offline Story recovery did not publish the exact retained commit.');
    }
    cloneRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-fresh-clone-'));
    const cloneStartedAt = performance.now();
    execFileSync('git', [
      'clone', '-q', '--single-branch', '--branch', workId, storyRemote, cloneRoot
    ], { stdio: 'ignore' });
    const cloneMilliseconds = performance.now() - cloneStartedAt;
    const cloneCommit = git(cloneRoot, 'rev-parse', 'HEAD');
    if (cloneCommit !== retainedCommit || git(cloneRoot, 'status', '--porcelain')) {
      throw new Error('Fresh clone did not reproduce the exact recovered Story commit cleanly.');
    }
    return {
      outcome: 'recovered',
      failureCode: /^[A-Z][A-Z0-9_]{2,127}$/.test(failure.code ?? '')
        ? failure.code : 'STORY_PUBLICATION_FAILED',
      failureMilliseconds,
      recoveryMilliseconds,
      exactRetainedCommitPublished: true,
      freshCloneMilliseconds: cloneMilliseconds,
      freshCloneExact: true,
      freshCloneClean: true
    };
  } finally {
    if (remoteUnavailable) await rename(unavailableRemote, storyRemote).catch(() => {});
    await Promise.all([
      cloneRoot ? rm(cloneRoot, { recursive: true, force: true }) : Promise.resolve(),
      rm(storyRoot, { recursive: true, force: true }),
      rm(storyRemote, { recursive: true, force: true }),
      rm(unavailableRemote, { recursive: true, force: true })
    ]);
  }
}

async function measureInterruptedWriteRecovery() {
  const { storyRoot, storyRemote } = await storyBenchmarkRepository();
  try {
    const workId = 'WEL-INTERRUPT-LOCAL';
    const target = 'wel-interrupted-state.json';
    const original = '{"status":"stable"}\n';
    await writeFile(path.join(storyRoot, target), original);
    git(storyRoot, 'add', target);
    git(storyRoot, 'commit', '-qm', 'add interrupted-write fixture');
    const originalCommit = git(storyRoot, 'rev-parse', 'HEAD');
    const publicationModule = new URL('../src/publication-unit-of-work.mjs', import.meta.url).href;
    const eventModule = new URL('../src/lifecycle-event.mjs', import.meta.url).href;
    const subject = { kind: 'story', id: workId, branch: 'main' };
    const childScript = [
      `import { writeFile } from 'node:fs/promises';`,
      `import { GitPublicationUnitOfWork } from ${JSON.stringify(publicationModule)};`,
      `import { lifecycleEvent } from ${JSON.stringify(eventModule)};`,
      `const root = ${JSON.stringify(storyRoot)};`,
      `const subject = ${JSON.stringify(subject)};`,
      `await new GitPublicationUnitOfWork(root).execute({`,
      `  subject, allowedPaths: [${JSON.stringify(target)}],`,
      `  event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),`,
      `  commit: { message: '[WEL] interrupted-write benchmark' },`,
      `  publication: { mode: 'off', branch: 'main' },`,
      `  state: { write: () => writeFile(root + '/' + ${JSON.stringify(target)}, '{"status":"partial"}\\n') },`,
      `  fault: (stage) => { if (stage === 'after-state-write') process.exit(73); }`,
      `});`
    ].join('\n');
    const failureStartedAt = performance.now();
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
      cwd: packageRoot, encoding: 'utf8', timeout: 30_000
    });
    const failureMilliseconds = performance.now() - failureStartedAt;
    if (child.status !== 73) {
      throw new Error('Interrupted-write exercise did not stop at its injected process boundary.');
    }
    const recoveryStartedAt = performance.now();
    execFileSync(process.execPath, [cli, 'sync', workId], {
      cwd: storyRoot, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, NODE_ENV: 'test',
        SINGULARITY_FLOW_TEST_IDENTITY: 'WEL Benchmark'
      }
    });
    const recoveryMilliseconds = performance.now() - recoveryStartedAt;
    if (git(storyRoot, 'rev-parse', 'HEAD') !== originalCommit
        || await readFile(path.join(storyRoot, target), 'utf8') !== original
        || git(storyRoot, 'status', '--porcelain')) {
      throw new Error('Interrupted-write recovery did not restore the exact stable state.');
    }
    return {
      outcome: 'recovered', failureCode: 'ABRUPT_PROCESS_EXIT',
      failureMilliseconds, recoveryMilliseconds, exactStableStateRestored: true
    };
  } finally {
    await Promise.all([
      rm(storyRoot, { recursive: true, force: true }),
      rm(storyRemote, { recursive: true, force: true })
    ]);
  }
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
  await recordContextPacketTelemetry(root, contextPacket());

  const durations = [];
  const reportDurations = [];
  const baselineProjectionDurations = [];
  const projectionDurations = [];
  const contextProjectionDurations = [];
  const cpuDurations = [];
  let catalogBytes = 0;
  let baselineReceiptBytes = 0;
  let receiptBytes = 0;
  let contextXrayBytes = 0;
  let outcome = 'unavailable';
  let unavailableCode = null;
  for (let index = 0; index < samples; index += 1) {
    const contextStartedAt = performance.now();
    const projection = await contextXray(root, contextWorkflow());
    contextProjectionDurations.push(performance.now() - contextStartedAt);
    contextXrayBytes = Buffer.byteLength(JSON.stringify(projection), 'utf8');
  }
  const storyStart = await measureStoryStarts(storySamples);
  const storyPushRecovery = await measureStoryPushRecovery();
  const storyOfflineRecovery = await measureStoryOfflineRecovery();
  const interruptedWriteRecovery = await measureInterruptedWriteRecovery();
  const cancellationStartedAt = performance.now();
  const cancellationController = new AbortController();
  cancellationController.abort();
  const cancelledObservation = await observeJunit5SurefireIdentities(
    root, command, parsedReport(replayLocalJunitObservation([{ contents: rawReport }])), policy,
    { signal: cancellationController.signal }
  );
  const cancellationMilliseconds = performance.now() - cancellationStartedAt;
  if (cancelledObservation?.exact !== false
      || !cancelledObservation?.gaps?.includes('JUNIT_SOURCE_PARSER_CANCELLED')
      || cancelledObservation?.mappingProposals?.length) {
    throw new Error('Cancelled WEL observation did not fail safely without an exact mapping.');
  }
  for (let index = 0; index < samples; index += 1) {
    const cpuStarted = process.cpuUsage();
    const reportStartedAt = performance.now();
    const replay = replayLocalJunitObservation([{ contents: rawReport }]);
    reportDurations.push(performance.now() - reportStartedAt);
    const parsed = parsedReport(replay);
    const check = {
      status: 'passed', exitCode: 0, stderr: '', sourceCommit: 'b'.repeat(40),
      sourceTreeSha256: 'c'.repeat(64), startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString()
    };
    const baselineProjectionStartedAt = performance.now();
    const baselineReceipt = buildTestExecutionReceipt(command, check, parsed);
    baselineProjectionDurations.push(performance.now() - baselineProjectionStartedAt);
    baselineReceiptBytes = Buffer.byteLength(JSON.stringify(baselineReceipt), 'utf8');
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
    const receipt = buildTestExecutionReceipt(command, check, parsed, {
      testcasePolicy: policy, exactTestcaseObservation: observation
    });
    projectionDurations.push(performance.now() - projectionStartedAt);
    receiptBytes = Buffer.byteLength(JSON.stringify(receipt), 'utf8');
    const cpu = process.cpuUsage(cpuStarted);
    cpuDurations.push((cpu.user + cpu.system) / 1_000);
  }
  const completed = outcome === 'observed' ? durations.length : 0;
  const projectionDeltas = projectionDurations.map(
    (duration, index) => duration - baselineProjectionDurations[index]
  );
  const report = {
    schema: WEL_BENCHMARK_SCHEMA,
    assurance: WEL_BENCHMARK_ASSURANCE,
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
    baselineReceiptProjectionMilliseconds: completed ? {
      minimum: Number(Math.min(...baselineProjectionDurations).toFixed(3)),
      median: Number(percentile(baselineProjectionDurations, 0.5).toFixed(3)),
      p95: Number(percentile(baselineProjectionDurations, 0.95).toFixed(3)),
      maximum: Number(Math.max(...baselineProjectionDurations).toFixed(3))
    } : null,
    incrementalReceiptProjectionMilliseconds: completed ? {
      minimum: Number(Math.min(...projectionDeltas).toFixed(3)),
      median: Number(percentile(projectionDeltas, 0.5).toFixed(3)),
      p95: Number(percentile(projectionDeltas, 0.95).toFixed(3)),
      maximum: Number(Math.max(...projectionDeltas).toFixed(3)),
      method: 'witnessed-minus-unenrolled-same-process'
    } : null,
    contextXrayProjectionMilliseconds: {
      minimum: Number(Math.min(...contextProjectionDurations).toFixed(3)),
      median: Number(percentile(contextProjectionDurations, 0.5).toFixed(3)),
      p95: Number(percentile(contextProjectionDurations, 0.95).toFixed(3)),
      maximum: Number(Math.max(...contextProjectionDurations).toFixed(3))
    },
    storyStartRequestedSamples: storySamples,
    storyStartCompletedSamples: storyStart.durations.length,
    storyStartMode: 'governed-local-publication-push-off',
    storyStartMilliseconds: {
      minimum: Number(Math.min(...storyStart.durations).toFixed(3)),
      median: Number(percentile(storyStart.durations, 0.5).toFixed(3)),
      p95: Number(percentile(storyStart.durations, 0.95).toFixed(3)),
      maximum: Number(Math.max(...storyStart.durations).toFixed(3))
    },
    storyTimingInterpretation: 'synthetic local Story-start transaction including its governed local commits; configuration authority uses a local bare remote and application push is disabled',
    storyPushRecovery: {
      outcome: storyPushRecovery.outcome,
      failureCode: storyPushRecovery.failureCode,
      failureMilliseconds: Number(storyPushRecovery.failureMilliseconds.toFixed(3)),
      recoveryMilliseconds: Number(storyPushRecovery.recoveryMilliseconds.toFixed(3)),
      exactRetainedCommitPublished: storyPushRecovery.exactRetainedCommitPublished
    },
    storyRecoveryInterpretation: 'synthetic local post-preflight transport loss followed by the public exact pending-publication sync path; this is not office-network evidence',
    storyOfflineRecovery: {
      outcome: storyOfflineRecovery.outcome,
      failureCode: storyOfflineRecovery.failureCode,
      failureMilliseconds: Number(storyOfflineRecovery.failureMilliseconds.toFixed(3)),
      recoveryMilliseconds: Number(storyOfflineRecovery.recoveryMilliseconds.toFixed(3)),
      exactRetainedCommitPublished: storyOfflineRecovery.exactRetainedCommitPublished,
      freshCloneMilliseconds: Number(storyOfflineRecovery.freshCloneMilliseconds.toFixed(3)),
      freshCloneExact: storyOfflineRecovery.freshCloneExact,
      freshCloneClean: storyOfflineRecovery.freshCloneClean
    },
    storyOfflineRecoveryInterpretation: 'synthetic local authority loss after publication preflight, exact public sync recovery, and clean fresh-clone verification; this is not office-network evidence',
    interruptedWriteRecovery: {
      outcome: interruptedWriteRecovery.outcome,
      failureCode: interruptedWriteRecovery.failureCode,
      failureMilliseconds: Number(interruptedWriteRecovery.failureMilliseconds.toFixed(3)),
      recoveryMilliseconds: Number(interruptedWriteRecovery.recoveryMilliseconds.toFixed(3)),
      exactStableStateRestored: interruptedWriteRecovery.exactStableStateRestored
    },
    interruptedWriteInterpretation: 'synthetic abrupt process exit after state write and before ref advancement, recovered through the public sync surface',
    adapterCancellation: {
      outcome: 'cancelled-safe',
      milliseconds: Number(cancellationMilliseconds.toFixed(3)),
      exact: false,
      mappingProposals: 0
    },
    adapterCancellationInterpretation: 'pre-cancelled exact-static observation returns unavailable evidence and creates no mapping proposal',
    timingInterpretation: 'paired local observation; signed deltas may be negative from timer noise and are not an enforced budget',
    cpuMilliseconds: completed ? {
      median: Number(percentile(cpuDurations, 0.5).toFixed(3)),
      p95: Number(percentile(cpuDurations, 0.95).toFixed(3))
    } : null,
    catalogBytes,
    baselineReceiptBytes,
    receiptBytes,
    incrementalReceiptBytes: outcome === 'observed' ? receiptBytes - baselineReceiptBytes : 0,
    contextXrayBytes,
    storyWorkflowBytes: storyStart.workflowBytes,
    rawReportBytes: rawReport.length,
    estimatedDurableBytesPerExecution: outcome === 'observed'
      ? receiptBytes + rawReport.length : 0,
    estimatedDurableIncrementalBytesPerExecution: outcome === 'observed'
      ? (receiptBytes - baselineReceiptBytes) + rawReport.length : 0,
    fixtureOutcomes: {
      cases: 1,
      exactStatic: outcome === 'observed' ? 1 : 0,
      inexact: outcome === 'observed' ? 0 : 1,
      falseExact: 0
    },
    measurementCapabilities: [...WEL_BENCHMARK_CAPABILITIES],
    contentExcluded: [...WEL_BENCHMARK_EXCLUDED_CONTENT]
  };
  const validated = validateWelBenchmarkEvidence(report, {
    platform: process.platform,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    requireObserved: false
  }).evidence;
  const serialized = `${JSON.stringify(validated)}\n`;
  if (outputPath) {
    const temporaryOutput = `${outputPath}.${process.pid}.tmp`;
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryOutput, serialized, { flag: 'wx', mode: 0o600 });
      await rename(temporaryOutput, outputPath);
    } finally {
      await rm(temporaryOutput, { force: true });
    }
  }
  process.stdout.write(serialized);
} finally {
  await rm(root, { recursive: true, force: true });
}
