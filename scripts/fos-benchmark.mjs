#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { FOS_FEATURE_DEFAULTS } from '../src/fos-features.mjs';
import { executeGitQuery } from '../src/git-query.mjs';
import { createRepoContext } from '../src/repo-context.mjs';
import { compareFosSemanticProjections } from '../src/fos-semantic-projection.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import {
  bootstrapFosAuthority, FOS_LOCAL_BOOTSTRAP_POLICY_ID
} from '../src/onboard.mjs';
import { mapLimit } from '../src/util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(
  path.join(packageRoot, 'benchmarks', 'fos', 'benchmark-manifest.json'), 'utf8'
));
const valueOption = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))
  ?.slice(name.length + 3);
const profile = valueOption('profile') ?? 'smoke';
if (!Object.hasOwn(manifest.profiles, profile)) throw new Error(`Unknown FOS benchmark profile '${profile}'.`);
const profileDefinition = manifest.profiles[profile];
const samplesArgument = process.argv.find((argument) => argument.startsWith('--samples='));
const samples = Number(samplesArgument?.slice('--samples='.length) ?? profileDefinition.minimumSamples);
if (!Number.isInteger(samples) || samples < 1 || samples > 30) {
  throw new Error('--samples must be an integer from 1 to 30.');
}
if (samples < profileDefinition.minimumSamples) {
  throw new Error(`FOS ${profile} evidence requires at least ${profileDefinition.minimumSamples} measured samples.`);
}
const runnerIdentity = valueOption('runner');
const powerMode = valueOption('power-mode');
const storageClass = valueOption('storage-class');
const filesystem = valueOption('filesystem');
if (profile === 'controlled') {
  for (const [name, value] of Object.entries({
    runner: runnerIdentity, 'power-mode': powerMode,
    'storage-class': storageClass, filesystem
  })) {
    if (!value || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(value)) {
      throw new Error(`Controlled FOS evidence requires --${name}=<lower-case-runner-fact>.`);
    }
  }
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

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function gitBytes(root, ...arguments_) {
  return execFileSync('git', arguments_, {
    cwd: root, encoding: null, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024
  });
}

async function fixtureHashes(root, definition) {
  const untrackedPaths = gitBytes(root, 'ls-files', '--others', '--exclude-standard', '-z')
    .toString('utf8').split('\0').filter(Boolean).sort();
  const untracked = await mapLimit(untrackedPaths, 32, async (relative) => ({
    path: relative,
    sha256: sha256(await readFile(path.join(root, relative)))
  }));
  const state = {
    generatorVersion: 1,
    definition,
    headTree: git(root, 'rev-parse', 'HEAD^{tree}'),
    stagedDiffSha256: sha256(gitBytes(root, '-c', 'diff.renames=false',
      'diff', '--cached', '--binary', '--full-index', '--no-ext-diff')),
    worktreeDiffSha256: sha256(gitBytes(root, '-c', 'diff.renames=false',
      'diff', '--binary', '--full-index', '--no-ext-diff')),
    untracked
  };
  return Object.freeze({
    definitionSha256: sha256(JSON.stringify(definition)),
    stateSha256: sha256(JSON.stringify(state))
  });
}

async function removeFixture(root) {
  await rm(root, {
    recursive: true,
    force: true,
    // Git can still be closing a freshly written pack/index on macOS and Windows when a fixture
    // finishes. Node's recursive-rm retry contract handles that bounded OS race without hiding a
    // persistent cleanup failure.
    maxRetries: 8,
    retryDelay: 50
  });
}

async function fixture(definition) {
  const fileCount = definition.trackedFiles;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-benchmark-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'FOS Benchmark');
  git(root, 'config', 'user.email', 'fos-benchmark@example.invalid');
  const directory = path.join(root, 'fixture');
  await mkdir(directory);
  await mapLimit(Array.from({ length: fileCount }), 32, (_, index) => writeFile(
    path.join(directory, `file-${String(index).padStart(5, '0')}.txt`), `fixture ${index}\n`
  ));
  if (definition.spacesAndUnicode) {
    await writeFile(path.join(directory, 'space and Unicode δ.txt'), 'portable fixture\n');
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'benchmark fixture');
  await mapLimit(Array.from({ length: definition.untrackedFiles ?? 0 }), 32, (_, index) => writeFile(
    path.join(directory, `untracked-${String(index).padStart(5, '0')}.txt`), `untracked ${index}\n`
  ));
  for (let index = 0; index < (definition.modifiedFiles ?? 0); index += 1) {
    await writeFile(path.join(directory, `file-${String(index).padStart(5, '0')}.txt`), `modified ${index}\n`);
  }
  const stagedOffset = definition.modifiedFiles ?? 0;
  for (let index = 0; index < (definition.stagedFiles ?? 0); index += 1) {
    const relative = `fixture/file-${String(stagedOffset + index).padStart(5, '0')}.txt`;
    await writeFile(path.join(root, relative), `staged ${index}\n`);
    git(root, 'add', '--', relative);
  }
  const renameOffset = stagedOffset + (definition.stagedFiles ?? 0);
  for (let index = 0; index < (definition.renamedFiles ?? 0); index += 1) {
    const from = `fixture/file-${String(renameOffset + index).padStart(5, '0')}.txt`;
    const to = `fixture/renamed ${String(index).padStart(3, '0')} δ.txt`;
    git(root, 'mv', '--', from, to);
  }
  const deleteOffset = renameOffset + (definition.renamedFiles ?? 0);
  for (let index = 0; index < (definition.deletedFiles ?? 0); index += 1) {
    await rm(path.join(directory, `file-${String(deleteOffset + index).padStart(5, '0')}.txt`));
  }
  return { root, hashes: await fixtureHashes(root, definition) };
}

const QUERIES = Object.freeze([
  ['repository.paths', {}], ['repository.root', {}], ['repository.object-format', {}],
  ['repository.bare', {}], ['repository.head', {}], ['repository.branch', {}],
  ['repository.local-branch-exists', { branch: 'main' }],
  ['repository.status', {}], ['repository.revision', {}],
  ['repository.tracked-paths', {}], ['repository.remotes', {}]
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
      logicalRequestCount: QUERIES.length * 2,
      batchRequestCount: 0,
      descendantGitProcessSpawnCount: 0,
      networkOperationCount: 0,
      cacheHitCount: cache ? QUERIES.length : 0,
      cacheMissCount: cache ? QUERIES.length : QUERIES.length * 2,
      coldRequestCount: requestsAfterCold,
      warmRequestCount: requests - requestsAfterCold,
      coldSpawnCount: requestsAfterCold,
      warmSpawnCount: requests - requestsAfterCold
    }
  };
}

function quantiles(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  const p50 = at(0.5);
  return { minimum: sorted[0], p50, median: p50, p95: at(0.95), maximum: sorted.at(-1) };
}

function processFailureDiagnostic(result, root) {
  const lines = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const selected = [...lines].reverse().find((line) => line.startsWith('Singularity Flow error:'))
    ?? result.error?.code ?? result.signal ?? 'no bounded provider diagnostic';
  return String(selected)
    .replaceAll(root, '<fixture>')
    .replaceAll(packageRoot, '<package>')
    .replace(/https?:\/\/[^\s]+/gi, '<remote>')
    .slice(0, 500);
}

async function measureFixture(id, definition) {
  const records = [];
  const created = await fixture(definition);
  const { root } = created;
  try {
    for (let warmup = 0; warmup < profileDefinition.warmupRuns; warmup += 1) {
      await lane(root, true);
      await lane(root, false);
    }
    for (let sample = 0; sample < samples; sample += 1) {
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
    }
  } finally {
    await removeFixture(root);
  }
  return {
    id, definition, hashes: created.hashes,
    measurementState: { process: 'warm-in-process', fosCache: 'cold-then-warm', osDisk: 'uncontrolled' },
    samples, warmupRuns: profileDefinition.warmupRuns, records,
    summary: {
      optimizedColdMs: quantiles(records.map((entry) => entry.optimized.coldMs)),
      optimizedWarmMs: quantiles(records.map((entry) => entry.optimized.warmMs)),
      noCacheWarmMs: quantiles(records.map((entry) => entry.noCache.warmMs)),
      optimizedWarmGitRequests: [...new Set(records.map((entry) => entry.optimized.warmRequestCount))],
      optimizedWarmGitSpawns: [...new Set(records.map((entry) => entry.optimized.warmSpawnCount))],
      noCacheWarmGitRequests: [...new Set(records.map((entry) => entry.noCache.warmRequestCount))],
      noCacheWarmGitSpawns: [...new Set(records.map((entry) => entry.noCache.warmSpawnCount))],
      semanticEquivalent: records.every((entry) => entry.semanticEquivalent)
    }
  };
}

async function measureLinkedWorktrees() {
  const records = [];
  const fixtureHashRecords = new Map();
  for (let sample = 0; sample < samples; sample += 1) {
    const created = await fixture({ trackedFiles: 64, untrackedFiles: 0 });
    const { root } = created;
    fixtureHashRecords.set(created.hashes.stateSha256, created.hashes);
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
      await removeFixture(linked);
      await removeFixture(root);
    }
  }
  return {
    id: 'linked-worktrees', definition: { trackedFiles: 64 },
    hashes: fixtureHashRecords.size === 1 ? [...fixtureHashRecords.values()][0] : null,
    measurementState: { process: 'warm-in-process', fosCache: 'identity-only', osDisk: 'uncontrolled' },
    samples, records,
    summary: {
      semanticEquivalent: records.every((entry) => entry.sameRepositoryInstance
        && entry.distinctWorktreeInstances && entry.sameCommonDirectory
        && entry.distinctGitDirectories)
    }
  };
}

function runOnboardSample(root) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [
    path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'onboard', root, '--authority-local', '--timings'
  ], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      SINGULARITY_FLOW_NO_MODEL: '1',
      ...(profile === 'controlled' ? { SINGULARITY_FLOW_DX_DURABLE_START: '1' } : {})
    }
  });
  const externalWallMs = performance.now() - started;
  if (result.status !== 0) throw new Error(
    `FOS onboarding benchmark failed with exit ${result.status}: ${processFailureDiagnostic(result, root)}`
  );
  const timing = /\[sflow timing\][^\n]*/.exec(result.stderr)?.[0];
  const internal = /\btotal=([0-9.]+)ms/.exec(timing ?? '')?.[1];
  const firstFeedback = /\bfirst-feedback=([0-9.]+)ms/.exec(timing ?? '')?.[1];
  if (internal == null) throw new Error('FOS onboarding benchmark did not emit its terminal timing.');
  if (firstFeedback == null) throw new Error('FOS onboarding benchmark did not emit first-feedback timing.');
  const counter = (name) => Number(new RegExp(
    `\\b${name.replaceAll('.', '\\.') }=([0-9.]+)`
  ).exec(timing)?.[1] ?? 0);
  return {
    externalWallMs,
    internalWallMs: Number(internal),
    firstFeedbackMs: Number(firstFeedback),
    counters: {
      gitRequests: counter('git.requests'), gitSpawns: counter('git.spawns'),
      gitChildSpawns: counter('git.child-spawns'), remoteOperations: counter('git.remote.total'),
      discoveryCalls: counter('discovery.calls'), compositionCalls: counter('composition.calls'),
      llmCalls: counter('llm.calls'), astCalls: counter('ast.calls')
    },
    completed: true
  };
}

async function measureExistingLocalOnboard(definition) {
  const created = await fixture(definition);
  const { root } = created;
  try {
    await bootstrapFosAuthority(root, {
      authorityLocal: true,
      policyId: FOS_LOCAL_BOOTSTRAP_POLICY_ID
    });
    for (let warmup = 0; warmup < profileDefinition.warmupRuns; warmup += 1) runOnboardSample(root);
    const records = Array.from({ length: samples }, (_, sample) => ({
      sample: sample + 1,
      ...runOnboardSample(root)
    }));
    return {
      id: 'existing-local-authority-onboard', hashes: created.hashes,
      measurementState: { process: 'cold', route: 'warm-local', osDisk: 'uncontrolled' },
      samples,
      warmupRuns: profileDefinition.warmupRuns,
      records,
      summary: {
        externalWallMs: quantiles(records.map((entry) => entry.externalWallMs)),
        internalWallMs: quantiles(records.map((entry) => entry.internalWallMs)),
        firstFeedbackMs: quantiles(records.map((entry) => entry.firstFeedbackMs)),
        gitRequests: [...new Set(records.map((entry) => entry.counters.gitRequests))],
        gitSpawns: [...new Set(records.map((entry) => entry.counters.gitSpawns))],
        gitChildSpawns: [...new Set(records.map((entry) => entry.counters.gitChildSpawns))],
        remoteOperations: [...new Set(records.map((entry) => entry.counters.remoteOperations))],
        forbiddenWorkCalls: [...new Set(records.map((entry) => entry.counters.discoveryCalls
          + entry.counters.compositionCalls + entry.counters.llmCalls + entry.counters.astCalls))],
        allCompleted: records.every((entry) => entry.completed)
      }
    };
  } finally {
    await removeFixture(root);
  }
}

const commit = git(packageRoot, 'rev-parse', 'HEAD');
const dirty = Boolean(git(packageRoot, 'status', '--porcelain=v1', '--untracked-files=all'));
if (profile === 'controlled' && dirty) {
  throw new Error('Controlled FOS evidence requires a clean exact implementation commit.');
}
if (profile === 'controlled' && !outputPath) {
  throw new Error('Controlled FOS evidence requires --out outside the repository.');
}

const fixtures = [];
for (const [id, definition] of Object.entries(profileDefinition.fixtures)) {
  fixtures.push(await measureFixture(id, definition));
}
fixtures.push(await measureLinkedWorktrees());
const externalCommands = [];
if (profile === 'controlled') {
  externalCommands.push(await measureExistingLocalOnboard(profileDefinition.fixtures['reference-local']));
}
const reference = fixtures.find((entry) => entry.id === 'reference-local');
const onboard = externalCommands.find((entry) => entry.id === 'existing-local-authority-onboard');
const checks = profile === 'controlled' ? {
  referenceWarmLatency: reference.summary.optimizedWarmMs.p95
    <= manifest.budgets['reference-local'].optimizedWarmP95Ms,
  referenceWarmRequests: reference.summary.optimizedWarmGitRequests.every((count) => count
    <= manifest.budgets['reference-local'].optimizedWarmGitRequests),
  referenceWarmSpawns: reference.summary.optimizedWarmGitSpawns.every((count) => count
    <= manifest.budgets['reference-local'].optimizedWarmGitSpawns),
  onboardExternalLatency: onboard.summary.externalWallMs.p95
    <= manifest.budgets['existing-local-authority-onboard'].externalWallP95Ms,
  onboardFirstFeedback: onboard.summary.firstFeedbackMs.p95
    <= manifest.budgets['existing-local-authority-onboard'].firstFeedbackP95Ms,
  onboardNoForbiddenWork: onboard.summary.forbiddenWorkCalls.every((count) => count === 0)
} : null;
const report = {
  schemaVersion: currentSchemaVersion('fos-benchmark-report'),
  kind: 'fos-local-benchmark-report',
  claimsAuthorized: false,
  profile,
  binding: { implementationCommit: commit, workingTree: dirty ? 'dirty-unbound' : 'clean', hashBound: !dirty },
  runner: {
    identity: runnerIdentity ?? 'unclaimed-local',
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    git: git(packageRoot, '--version').replace(/^git version\s+/, ''),
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    memoryBytes: os.totalmem(),
    storageClass: storageClass ?? 'unreported',
    filesystem: filesystem ?? 'unreported',
    powerMode: powerMode ?? 'unreported'
  },
  featureState: FOS_FEATURE_DEFAULTS,
  manifest: {
    schemaVersion: manifest.schemaVersion,
    specificationSha256: manifest.specificationSha256,
    budgets: manifest.budgets
  },
  coverage: {
    localFixtures: fixtures.map((entry) => entry.id),
    externallyMeasuredCommands: externalCommands.map((entry) => entry.id),
    notMeasured: profile === 'controlled'
      ? ['controlled-network-completion', 'office-remote', 'vscode-hosts', 'other-platforms']
      : ['first-feedback', 'network-completion', 'office-remote',
        'fault-matrix', 'vscode-hosts', 'other-platforms']
  },
  evaluation: checks == null ? null : {
    checks,
    status: Object.values(checks).every(Boolean) ? 'passed' : 'failed'
  },
  fixtures,
  externalCommands
};
report.reportSha256 = sha256(JSON.stringify(report));
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, { mode: 0o600 });
}
process.stdout.write(serialized);
if (!fixtures.every((entry) => entry.summary.semanticEquivalent)
    || report.evaluation?.status === 'failed') process.exitCode = 1;
