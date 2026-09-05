#!/usr/bin/env node
/**
 * Content-free CMP P1 measurement harness.
 *
 * The benchmark creates a private synthetic Git fixture, exercises the exact repository-change-set
 * adapter plus the observe-only CMP projection, and emits aggregate counts/timings only. It never
 * records paths, digests, source bytes, causes, identities, work IDs, prompts, or transcripts.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildChangeRegionManifest, evaluateComprehensionCoverage } from '../src/comprehension/contracts.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';

const sampleArgument = process.argv.find((argument) => argument.startsWith('--samples='));
const samples = Number(sampleArgument?.slice('--samples='.length) ?? 12);
if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
  throw new Error('--samples must be an integer from 1 to 100');
}

function git(root, args) {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  });
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    minimum: Number(sorted[0].toFixed(3)),
    median: Number(at(0.5).toFixed(3)),
    p95: Number(at(0.95).toFixed(3)),
    maximum: Number(sorted.at(-1).toFixed(3))
  };
}

function countsByCode(records) {
  const counts = {};
  for (const record of records) counts[record.code] = (counts[record.code] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function createFixture(root) {
  await Promise.all([
    mkdir(path.join(root, 'src'), { recursive: true }),
    mkdir(path.join(root, 'config'), { recursive: true }),
    mkdir(path.join(root, 'docs'), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, 'src', 'modified.txt'), 'before\n'),
    writeFile(path.join(root, 'src', 'deleted.txt'), 'remove me\n'),
    writeFile(path.join(root, 'src', 'renamed.txt'), 'rename me\n'),
    writeFile(path.join(root, 'src', 'mode.sh'), '#!/bin/sh\nexit 0\n'),
    writeFile(path.join(root, 'src', 'binary.dat'), Buffer.from([0, 1, 2, 3])),
    writeFile(path.join(root, 'config', 'settings.yml'), 'enabled: false\n'),
    writeFile(path.join(root, 'docs', 'guide.md'), '# Before\n')
  ]);
  await chmod(path.join(root, 'src', 'mode.sh'), 0o644);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'CMP Benchmark']);
  git(root, ['config', 'user.email', 'cmp-benchmark@example.invalid']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'benchmark baseline']);

  await Promise.all([
    writeFile(path.join(root, 'src', 'modified.txt'), 'after\n'),
    writeFile(path.join(root, 'src', 'binary.dat'), Buffer.from([0, 4, 5, 6, 7])),
    writeFile(path.join(root, 'config', 'settings.yml'), 'enabled: true\n'),
    writeFile(path.join(root, 'docs', 'guide.md'), '# After\n'),
    mkdir(path.join(root, 'generated'), { recursive: true }),
    mkdir(path.join(root, 'test'), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, 'generated', 'client.txt'), 'generated\n'),
    writeFile(path.join(root, 'test', 'new.test'), 'test\n'),
    unlink(path.join(root, 'src', 'deleted.txt')),
    chmod(path.join(root, 'src', 'mode.sh'), 0o755)
  ]);
  git(root, ['mv', 'src/renamed.txt', 'src/renamed-new.txt']);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-benchmark-'));
try {
  await createFixture(root);
  const changeSetDurations = [];
  const manifestDurations = [];
  const coverageDurations = [];
  const totalDurations = [];
  const cpuDurations = [];
  let manifest;
  let coverage;

  for (let index = 0; index < samples; index += 1) {
    const totalStartedAt = performance.now();
    const cpuStarted = process.cpuUsage();
    const changeSetStartedAt = performance.now();
    const changeSet = await buildRepositoryChangeSet(root, {
      baseCommit: 'HEAD',
      subject: { kind: 'comprehension-observation', workId: null, phase: null }
    });
    changeSetDurations.push(performance.now() - changeSetStartedAt);

    const manifestStartedAt = performance.now();
    manifest = buildChangeRegionManifest(changeSet);
    manifestDurations.push(performance.now() - manifestStartedAt);

    const coverageStartedAt = performance.now();
    coverage = evaluateComprehensionCoverage({ changeSet, manifest });
    coverageDurations.push(performance.now() - coverageStartedAt);
    totalDurations.push(performance.now() - totalStartedAt);
    const cpu = process.cpuUsage(cpuStarted);
    cpuDurations.push((cpu.user + cpu.system) / 1_000);
  }

  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
  const coverageBytes = Buffer.byteLength(JSON.stringify(coverage), 'utf8');
  const previewRecordBytes = Buffer.byteLength(JSON.stringify({
    manifestSha256: manifest.manifestSha256,
    resultSha256: coverage.resultSha256,
    counts: coverage.counts
  }), 'utf8');
  const report = {
    schema: 'sflow-cmp-benchmark/v1',
    assurance: 'content-free-local-measurement',
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    requestedSamples: samples,
    completedSamples: samples,
    outcome: 'observed',
    fixtureProfile: 'synthetic-mixed-change-v1',
    timingsMilliseconds: {
      changeSet: distribution(changeSetDurations),
      regionProjection: distribution(manifestDurations),
      coverageEvaluation: distribution(coverageDurations),
      total: distribution(totalDurations),
      cpu: distribution(cpuDurations)
    },
    counts: {
      regions: manifest.counts.regions,
      materialRegions: coverage.counts.materialRegions,
      unresolved: coverage.counts.unresolved,
      diagnostics: coverage.counts.diagnostics,
      unresolvedByCode: countsByCode(coverage.unresolved),
      diagnosticsByCode: countsByCode(coverage.diagnostics)
    },
    availability: {
      exactRepositoryChangeSet: 'available',
      structuralExtraction: 'not-invoked',
      model: 'not-invoked',
      cache: 'not-used-observe-only'
    },
    storageBytes: {
      manifest: manifestBytes,
      coverage: coverageBytes,
      recordModePreview: previewRecordBytes
    },
    lifecycleGate: false,
    authoritative: false,
    contentExcluded: [
      'repository-path', 'file-path', 'content-digest', 'source-bytes', 'cause-statement',
      'work-id', 'git-identity', 'prompt', 'transcript'
    ]
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
