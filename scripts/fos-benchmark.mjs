#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { FOS_FEATURE_DEFAULTS } from '../src/fos-features.mjs';
import { executeGitQuery } from '../src/git-query.mjs';
import { createRepoContext } from '../src/repo-context.mjs';
import { compareFosSemanticProjections } from '../src/fos-semantic-projection.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(
  path.join(packageRoot, 'benchmarks', 'fos', 'benchmark-manifest.json'), 'utf8'
));
const samplesArgument = process.argv.find((argument) => argument.startsWith('--samples='));
const samples = Number(samplesArgument?.slice('--samples='.length) ?? 3);
if (!Number.isInteger(samples) || samples < 1 || samples > 30) {
  throw new Error('--samples must be an integer from 1 to 30.');
}
const outputArgument = process.argv.find((argument) => argument.startsWith('--out='));
const outputPath = outputArgument ? path.resolve(outputArgument.slice('--out='.length)) : null;
if (outputPath && (outputPath === packageRoot || outputPath.startsWith(`${packageRoot}${path.sep}`))) {
  throw new Error('FOS benchmark output must stay outside the repository.');
}

function git(root, ...arguments_) {
  return execFileSync('git', arguments_, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

async function fixture(fileCount) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-benchmark-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'FOS Benchmark');
  git(root, 'config', 'user.email', 'fos-benchmark@example.invalid');
  const directory = path.join(root, 'fixture');
  await mkdir(directory);
  await Promise.all(Array.from({ length: fileCount }, (_, index) => writeFile(
    path.join(directory, `file-${String(index).padStart(5, '0')}.txt`), `fixture ${index}\n`
  )));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'benchmark fixture');
  return root;
}

const QUERIES = Object.freeze([
  ['repository.paths', {}], ['repository.root', {}], ['repository.object-format', {}],
  ['repository.bare', {}], ['repository.head', {}], ['repository.branch', {}],
  ['repository.status', {}], ['repository.tracked-paths', {}], ['repository.remotes', {}]
]);

async function observe(context) {
  const observations = {};
  for (const [id, params] of QUERIES) observations[id] = await context.observe(id, params);
  return observations;
}

async function lane(root, cache) {
  let requests = 0;
  let serviceMs = 0;
  const execute = (repository, id, params) => {
    requests += 1;
    const started = performance.now();
    try { return executeGitQuery(repository, id, params); }
    finally { serviceMs += performance.now() - started; }
  };
  const context = createRepoContext(root, { cache, execute });
  const coldStarted = performance.now();
  const cold = await observe(context);
  const coldMs = performance.now() - coldStarted;
  const requestsAfterCold = requests;
  const warmStarted = performance.now();
  const warm = await observe(context);
  const warmMs = performance.now() - warmStarted;
  return {
    cold, warm, metrics: {
      coldMs, warmMs, gitServiceMs: serviceMs,
      gitRequestCount: requests,
      gitProcessSpawnCount: requests,
      coldRequestCount: requestsAfterCold,
      warmRequestCount: requests - requestsAfterCold
    }
  };
}

function quantiles(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { minimum: sorted[0], median: at(0.5), p95: at(0.95), maximum: sorted.at(-1) };
}

async function measureFixture(id, fileCount) {
  const records = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const root = await fixture(fileCount);
    try {
      const before = process.memoryUsage().rss;
      const optimized = await lane(root, true);
      const reference = await lane(root, false);
      const after = process.memoryUsage().rss;
      const coldComparison = compareFosSemanticProjections(reference.cold, optimized.cold);
      const warmComparison = compareFosSemanticProjections(reference.warm, optimized.warm);
      records.push({
        sample: sample + 1,
        optimized: optimized.metrics,
        noCache: reference.metrics,
        semanticEquivalent: coldComparison.equivalent && warmComparison.equivalent,
        maximumObservedRssBytes: Math.max(before, after)
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  return {
    id, fileCount, samples, records,
    summary: {
      optimizedColdMs: quantiles(records.map((entry) => entry.optimized.coldMs)),
      optimizedWarmMs: quantiles(records.map((entry) => entry.optimized.warmMs)),
      noCacheWarmMs: quantiles(records.map((entry) => entry.noCache.warmMs)),
      optimizedWarmGitRequests: [...new Set(records.map((entry) => entry.optimized.warmRequestCount))],
      noCacheWarmGitRequests: [...new Set(records.map((entry) => entry.noCache.warmRequestCount))],
      semanticEquivalent: records.every((entry) => entry.semanticEquivalent)
    }
  };
}

async function measureLinkedWorktrees() {
  const records = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const root = await fixture(64);
    const linked = `${root}-linked`;
    try {
      git(root, 'worktree', 'add', '-q', '-b', 'benchmark-linked', linked);
      const primary = await createRepoContext(root).identity();
      const secondary = await createRepoContext(linked).identity();
      records.push({
        sample: sample + 1,
        sameRepositoryInstance: primary.repositoryInstanceId === secondary.repositoryInstanceId,
        distinctWorktreeInstances: primary.worktreeInstanceId !== secondary.worktreeInstanceId,
        sameCommonDirectory: primary.commonDir === secondary.commonDir,
        distinctGitDirectories: primary.gitDir !== secondary.gitDir
      });
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
  return {
    id: 'linked-worktrees', fileCount: 64, samples, records,
    summary: {
      semanticEquivalent: records.every((entry) => entry.sameRepositoryInstance
        && entry.distinctWorktreeInstances && entry.sameCommonDirectory
        && entry.distinctGitDirectories)
    }
  };
}

const fixtures = [];
fixtures.push(await measureFixture('small-local', 32));
fixtures.push(await measureFixture('medium-local', 512));
fixtures.push(await measureLinkedWorktrees());
const commit = git(packageRoot, 'rev-parse', 'HEAD');
const dirty = Boolean(git(packageRoot, 'status', '--porcelain=v1', '--untracked-files=all'));
const report = {
  schemaVersion: 1,
  kind: 'fos-local-benchmark-report',
  claimsAuthorized: false,
  binding: { implementationCommit: commit, workingTree: dirty ? 'dirty-unbound' : 'clean', hashBound: !dirty },
  runner: { platform: process.platform, architecture: process.arch, node: process.versions.node },
  featureState: FOS_FEATURE_DEFAULTS,
  manifest: {
    schemaVersion: manifest.schemaVersion,
    specificationSha256: manifest.specificationSha256,
    budgets: manifest.budgets
  },
  coverage: {
    localFixtures: fixtures.map((entry) => entry.id),
    notMeasured: [
      'first-feedback', 'network-completion', 'office-remote',
      'fault-matrix', 'vscode-hosts', 'other-platforms'
    ]
  },
  fixtures
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, { mode: 0o600 });
}
process.stdout.write(serialized);
if (!fixtures.every((entry) => entry.summary.semanticEquivalent)) process.exitCode = 1;
