#!/usr/bin/env node
/**
 * Privacy-safe CMP measurement over explicitly selected real repositories.
 *
 * This runner is intentionally separate from the release-gated synthetic benchmark. It reads the
 * exact current Git change set, emits only aggregate timings/counts/byte sizes, and verifies that
 * the selected repositories have the same HEAD and porcelain state after measurement. It never
 * invokes a model, AST, a remote, a lifecycle operation, or a writer.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  buildChangeRegionManifest, evaluateComprehensionCoverage
} from '../src/comprehension/contracts.mjs';
import { buildComprehensionRecordPreview } from '../src/comprehension/record-preview.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';

const MAX_REPOSITORIES = 16;
const MAX_SAMPLES = 20;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
// The runner owns this short-lived process. Apply the noninteractive/no-refresh boundary to the
// repository-change-set implementation as well as the explicit validation probes below.
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GCM_INTERACTIVE = 'Never';
process.env.GIT_OPTIONAL_LOCKS = '0';
const GIT_ENVIRONMENT = Object.freeze({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
  GIT_OPTIONAL_LOCKS: '0'
});

function fail(message) {
  throw new Error(`CMP_REAL_CORPUS_INVALID: ${message}`);
}

function optionValue(argv, index, name) {
  const argument = argv[index];
  const prefix = `--${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), next: index };
  if (argument === `--${name}`) {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      fail(`--${name} requires a value.`);
    }
    return { value: argv[index + 1], next: index + 1 };
  }
  return null;
}

function argumentsFrom(argv) {
  const parsed = { repositories: [], samples: 3, base: 'HEAD' };
  for (let index = 2; index < argv.length; index += 1) {
    const repository = optionValue(argv, index, 'repository');
    if (repository) {
      parsed.repositories.push(repository.value);
      index = repository.next;
      continue;
    }
    const samples = optionValue(argv, index, 'samples');
    if (samples) {
      parsed.samples = Number(samples.value);
      index = samples.next;
      continue;
    }
    const base = optionValue(argv, index, 'base');
    if (base) {
      parsed.base = base.value;
      index = base.next;
      continue;
    }
    fail(`unknown option at argument ${index - 1}.`);
  }
  if (parsed.repositories.length < 1 || parsed.repositories.length > MAX_REPOSITORIES) {
    fail(`provide 1 to ${MAX_REPOSITORIES} --repository values.`);
  }
  if (!Number.isInteger(parsed.samples) || parsed.samples < 1 || parsed.samples > MAX_SAMPLES) {
    fail(`--samples must be an integer from 1 to ${MAX_SAMPLES}.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,255}$/u.test(parsed.base)
      || parsed.base.includes('..')) {
    fail('--base must be one bounded Git commit revision, not an option or range.');
  }
  return parsed;
}

function gitBytes(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    env: GIT_ENVIRONMENT,
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function gitText(root, args) {
  return gitBytes(root, args).toString('utf8').trim();
}

function repositoryStateFingerprint(root) {
  const hash = createHash('sha256');
  hash.update(gitBytes(root, ['rev-parse', '--verify', 'HEAD']));
  hash.update('\0');
  hash.update(gitBytes(root, [
    '-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'
  ]));
  return hash.digest('hex');
}

async function verifiedRepositories(inputs, base) {
  const repositories = [];
  const seen = new Set();
  for (let index = 0; index < inputs.length; index += 1) {
    try {
      if (!inputs[index] || Buffer.byteLength(inputs[index], 'utf8') > 4096
          || /[\0\r\n]/u.test(inputs[index])) fail(`repository input ${index + 1} is invalid.`);
      const canonical = await realpath(inputs[index]);
      const info = await lstat(canonical);
      if (!info.isDirectory()) fail(`repository input ${index + 1} is not a directory.`);
      const top = await realpath(gitText(canonical, ['rev-parse', '--show-toplevel']));
      if (top !== canonical) fail(`repository input ${index + 1} is not an exact Git root.`);
      gitBytes(canonical, ['rev-parse', '--verify', `${base}^{commit}`]);
      if (seen.has(canonical)) fail(`repository input ${index + 1} duplicates an earlier input.`);
      seen.add(canonical);
      repositories.push(canonical);
    } catch (error) {
      if (String(error?.message ?? '').startsWith('CMP_REAL_CORPUS_INVALID:')) throw error;
      fail(`repository input ${index + 1} could not be verified without network access.`);
    }
  }
  return repositories;
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

function incrementByCode(target, records) {
  for (const record of records) target[record.code] = (target[record.code] ?? 0) + 1;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

const requested = argumentsFrom(process.argv);
const repositories = await verifiedRepositories(requested.repositories, requested.base);
const timings = { changeSet: [], regionProjection: [], coverageEvaluation: [], total: [], cpu: [] };
const storage = { manifest: [], coverage: [], recordModePreview: [] };
const counts = {
  repositoriesWithChanges: 0,
  repositoriesWithoutChanges: 0,
  regions: 0,
  materialRegions: 0,
  unresolved: 0,
  diagnostics: 0,
  unresolvedByCode: {},
  diagnosticsByCode: {}
};

for (let repositoryIndex = 0; repositoryIndex < repositories.length; repositoryIndex += 1) {
  const repository = repositories[repositoryIndex];
  const before = repositoryStateFingerprint(repository);
  let finalManifest;
  let finalCoverage;
  let finalPreview;
  try {
    for (let sample = 0; sample < requested.samples; sample += 1) {
      const totalStartedAt = performance.now();
      const cpuStarted = process.cpuUsage();
      const changeSetStartedAt = performance.now();
      const changeSet = await buildRepositoryChangeSet(repository, {
        baseCommit: requested.base,
        subject: { kind: 'comprehension-observation', workId: null, phase: null }
      });
      timings.changeSet.push(performance.now() - changeSetStartedAt);

      const manifestStartedAt = performance.now();
      finalManifest = buildChangeRegionManifest(changeSet);
      timings.regionProjection.push(performance.now() - manifestStartedAt);

      const coverageStartedAt = performance.now();
      finalCoverage = evaluateComprehensionCoverage({ changeSet, manifest: finalManifest });
      finalPreview = buildComprehensionRecordPreview({ manifest: finalManifest, coverage: finalCoverage });
      timings.coverageEvaluation.push(performance.now() - coverageStartedAt);
      timings.total.push(performance.now() - totalStartedAt);
      const cpu = process.cpuUsage(cpuStarted);
      timings.cpu.push((cpu.user + cpu.system) / 1_000);
    }

    if (repositoryStateFingerprint(repository) !== before) {
      fail(`repository input ${repositoryIndex + 1} changed while it was measured.`);
    }
  } catch (error) {
    if (String(error?.message ?? '').startsWith('CMP_REAL_CORPUS_INVALID:')) throw error;
    fail(`repository input ${repositoryIndex + 1} could not be measured safely.`);
  }

  const regionCount = finalManifest.counts.regions;
  counts.repositoriesWithChanges += regionCount > 0 ? 1 : 0;
  counts.repositoriesWithoutChanges += regionCount === 0 ? 1 : 0;
  counts.regions += regionCount;
  counts.materialRegions += finalCoverage.counts.materialRegions;
  counts.unresolved += finalCoverage.counts.unresolved;
  counts.diagnostics += finalCoverage.counts.diagnostics;
  incrementByCode(counts.unresolvedByCode, finalCoverage.unresolved);
  incrementByCode(counts.diagnosticsByCode, finalCoverage.diagnostics);
  storage.manifest.push(Buffer.byteLength(JSON.stringify(finalManifest), 'utf8'));
  storage.coverage.push(Buffer.byteLength(JSON.stringify(finalCoverage), 'utf8'));
  storage.recordModePreview.push(Buffer.byteLength(JSON.stringify(finalPreview), 'utf8'));
}

const report = {
  schema: 'sflow-cmp-real-corpus/v1',
  assurance: 'content-free-local-measurement',
  authority: 'none',
  platform: process.platform,
  architecture: process.arch,
  nodeMajor: Number(process.versions.node.split('.')[0]),
  corpusProfile: 'operator-selected-real-repositories-v1',
  inputBinding: 'operator-reviewed-out-of-band',
  repositoryCount: repositories.length,
  requestedSamplesPerRepository: requested.samples,
  completedMeasurements: repositories.length * requested.samples,
  outcome: counts.repositoriesWithChanges > 0 ? 'observed' : 'no-changes',
  timingsMilliseconds: Object.fromEntries(
    Object.entries(timings).map(([name, values]) => [name, distribution(values)])
  ),
  counts: {
    ...counts,
    unresolvedByCode: sortedCounts(counts.unresolvedByCode),
    diagnosticsByCode: sortedCounts(counts.diagnosticsByCode)
  },
  storageBytesPerRepository: Object.fromEntries(
    Object.entries(storage).map(([name, values]) => [name, distribution(values)])
  ),
  availability: {
    exactRepositoryChangeSet: 'available',
    structuralExtraction: 'not-invoked',
    model: 'not-invoked',
    network: 'not-invoked',
    cache: 'not-used-observe-only'
  },
  repositoryState: 'unchanged-observed',
  lifecycleGate: false,
  authoritative: false,
  contentExcluded: [
    'repository-path', 'file-path', 'content-digest', 'source-bytes', 'cause-statement',
    'work-id', 'git-identity', 'prompt', 'transcript'
  ]
};

process.stdout.write(`${JSON.stringify(report)}\n`);
