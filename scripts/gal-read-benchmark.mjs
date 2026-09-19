#!/usr/bin/env node
/**
 * Reproducible, local-only qualification probe for the implemented GAL read paths.
 * This is measurement evidence, not a lifecycle gate or cross-platform certification.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { withCommandTiming } from '../src/dx-timing-context.mjs';
import { fosGitObjectService, closeFosGitObjectServices } from '../src/fos-object-service.mjs';
import { createGitRuntime } from '../src/git-access.mjs';
import { readLocalGitBlobs } from '../src/git-blob-batch.mjs';
import { readLocalGitBlobsAsync } from '../src/git-local-blob-async.mjs';
import { run } from '../src/util.mjs';

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OBJECT_BYTES = 1_024;
const PERSISTENT_BATCH_OBJECTS = 128;

function options(argv) {
  const selected = { samples: 3, objects: 500 };
  for (const arg of argv) {
    const match = /^--(samples|objects)=(\d+)$/u.exec(arg);
    if (!match) throw new Error('Unknown or malformed benchmark argument. Use --samples=N and --objects=N.');
    selected[match[1]] = Number(match[2]);
  }
  if (!Number.isSafeInteger(selected.samples) || selected.samples < 1 || selected.samples > 10) {
    throw new Error('--samples must be an integer from 1 to 10.');
  }
  if (!Number.isSafeInteger(selected.objects) || selected.objects < 1 || selected.objects > 500) {
    throw new Error('--objects must be an integer from 1 to 500.');
  }
  return selected;
}

function git(executable, args, { cwd, env, encoding = 'utf8', maxBuffer = 8 * 1024 * 1024 } = {}) {
  const result = spawnSync(executable, args, {
    cwd, env, encoding, maxBuffer, timeout: 30_000, windowsHide: true, shell: false
  });
  if (result.status !== 0 || result.error) {
    const code = result.error?.code ?? `exit-${result.status ?? 'unknown'}`;
    throw Object.assign(new Error(`Local benchmark Git command failed (${code}).`), {
      code: 'GAL_BENCHMARK_FIXTURE_GIT_FAILED'
    });
  }
  return result.stdout;
}

function safeFixtureEnvironment(globalConfig) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/iu.test(key)) delete env[key];
  return {
    ...env, GIT_CONFIG_SYSTEM: globalConfig, GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C'
  };
}

function content(index) {
  const bytes = Buffer.alloc(OBJECT_BYTES, index % 251);
  bytes.write(`GAL-FIXTURE-${String(index).padStart(4, '0')}\n`, 0, 'ascii');
  return bytes;
}

async function fixture(base, executable, objectCount) {
  const root = path.join(base, 'repo');
  const globalConfig = path.join(base, 'empty-git-config');
  await mkdir(root);
  await writeFile(globalConfig, '');
  const env = safeFixtureEnvironment(globalConfig);
  git(executable, ['init', '--quiet'], { cwd: root, env });
  const expectedByName = new Map();
  for (let index = 0; index < objectCount; index += 1) {
    const name = `object-${String(index).padStart(4, '0')}.bin`;
    const bytes = content(index);
    await writeFile(path.join(root, name), bytes);
    expectedByName.set(name, bytes);
  }
  git(executable, ['add', '--all'], { cwd: root, env });
  const indexBytes = git(executable, ['ls-files', '--stage', '-z'], {
    cwd: root, env, encoding: 'buffer'
  });
  const entries = indexBytes.toString('utf8').split('\0').filter(Boolean);
  assert.equal(entries.length, objectCount, 'fixture index count');
  const oids = [];
  const expectedByOid = new Map();
  for (const entry of entries) {
    const match = /^100644 ([0-9a-f]{40}|[0-9a-f]{64}) 0\t(object-\d{4}\.bin)$/u.exec(entry);
    assert.ok(match, 'fixture index entry');
    const bytes = expectedByName.get(match[2]);
    assert.ok(bytes, 'fixture path');
    oids.push(match[1]);
    expectedByOid.set(match[1], bytes);
  }
  assert.equal(new Set(oids).size, objectCount, 'fixture object uniqueness');
  const fixtureSha256 = createHash('sha256').update(oids.join('\n')).digest('hex');
  return { root, env, oids, expectedByOid, fixtureSha256 };
}

function counter() {
  const counts = new Map();
  return {
    increment(name, amount = 1) {
      counts.set(name, (counts.get(name) ?? 0) + amount);
      return counts.get(name);
    },
    feedback() {},
    get(name) { return counts.get(name) ?? 0; }
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.min(sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1))].toFixed(3));
}

function distribution(samples) {
  return {
    min: percentile(samples, 0), median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95), max: percentile(samples, 1)
  };
}

function assertParity(values, expectedByOid) {
  assert.equal(values.size, expectedByOid.size, 'complete object set');
  for (const [oid, expected] of expectedByOid) {
    const actual = values.get(oid);
    assert.ok(Buffer.isBuffer(actual), 'object bytes');
    assert.ok(actual.equals(expected), 'exact object-byte parity');
  }
}

async function coldRuntimeSample(root, env) {
  const timing = counter();
  const start = performance.now();
  const { value: runtime, ok } = await withCommandTiming(timing, async () => {
    const created = await createGitRuntime({ trustedEnvironment: env });
    assert.equal(created.ok, true, created.code ?? 'runtime');
    const opened = await created.value.openRepository(root);
    assert.equal(opened.ok, true, opened.code ?? 'repository');
    assert.equal(opened.value.identity.bare, false);
    await opened.value.dispose();
    return created;
  });
  assert.equal(ok, true);
  await runtime.dispose();
  return { milliseconds: performance.now() - start, gitSpawns: timing.get('git.spawns') };
}

function referenceSample(executable, source) {
  let physicalSpawns = 0;
  const start = performance.now();
  const values = readLocalGitBlobs(source.root, source.oids, {
    env: source.env, maximumBytes: source.oids.length * OBJECT_BYTES,
    maximumObjectBytes: OBJECT_BYTES, maximumBatchBytes: 16 * 1024 * 1024,
    runCommand: (_logical, args, selected) => {
      physicalSpawns += 1;
      return run(executable, args, { ...selected, recordGitTiming: false });
    }
  });
  const milliseconds = performance.now() - start;
  assertParity(values, source.expectedByOid);
  return { milliseconds, gitSpawns: physicalSpawns };
}

async function asyncReferenceSample(executable, source) {
  const timing = counter();
  const start = performance.now();
  const values = await withCommandTiming(timing, () => readLocalGitBlobsAsync(
    source.root, source.oids, {
      executable, env: source.env,
      maximumBytes: source.oids.length * OBJECT_BYTES,
      maximumObjectBytes: OBJECT_BYTES,
      maximumBatchBytes: 16 * 1024 * 1024
    }
  ));
  const milliseconds = performance.now() - start;
  assertParity(values, source.expectedByOid);
  return {
    milliseconds,
    gitSpawns: timing.get('git.spawns'),
    logicalRequests: timing.get('git.requests')
  };
}

async function persistentSample(service, source) {
  const before = service.processSpawns;
  const timing = counter();
  const values = new Map();
  const start = performance.now();
  await withCommandTiming(timing, async () => {
    for (const oid of source.oids) values.set(oid, (await service.read(oid))?.bytes);
  });
  const milliseconds = performance.now() - start;
  assertParity(values, source.expectedByOid);
  assert.equal(timing.get('git.child-spawns'), service.processSpawns - before);
  return {
    milliseconds, gitSpawns: timing.get('git.spawns'),
    workerSpawns: service.processSpawns - before,
    logicalRequests: timing.get('git.requests')
  };
}

async function persistentBatchSample(service, source) {
  const before = service.processSpawns;
  const timing = counter();
  const values = new Map();
  const start = performance.now();
  await withCommandTiming(timing, async () => {
    for (let offset = 0; offset < source.oids.length; offset += PERSISTENT_BATCH_OBJECTS) {
      const oids = source.oids.slice(offset, offset + PERSISTENT_BATCH_OBJECTS);
      const entries = await service.readBatch(oids);
      assert.equal(entries.length, oids.length, 'complete persistent batch');
      for (let index = 0; index < entries.length; index += 1) {
        assert.equal(entries[index]?.oid, oids[index], 'ordered persistent batch object');
        assert.equal(entries[index]?.type, 'blob', 'persistent batch object type');
        values.set(oids[index], entries[index].bytes);
      }
    }
  });
  const milliseconds = performance.now() - start;
  assertParity(values, source.expectedByOid);
  const expectedWrites = Math.ceil(source.oids.length / PERSISTENT_BATCH_OBJECTS);
  assert.equal(timing.get('git.requests'), expectedWrites, 'one logical call per chunk');
  assert.equal(timing.get('git.batch-requests'), expectedWrites, 'one worker write per chunk');
  assert.equal(timing.get('git.child-spawns'), service.processSpawns - before);
  return {
    milliseconds, gitSpawns: timing.get('git.spawns'),
    workerSpawns: service.processSpawns - before,
    logicalRequests: timing.get('git.requests'),
    logicalObjectReads: source.oids.length,
    workerWrites: timing.get('git.batch-requests')
  };
}

async function main() {
  const selected = options(process.argv.slice(2));
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-benchmark-'));
  try {
    const setup = await createGitRuntime();
    assert.equal(setup.ok, true, setup.code ?? 'Git executable unavailable');
    const executable = setup.value.identity.path;
    const gitVersion = setup.value.identity.version;
    await setup.value.dispose();
    const source = await fixture(base, executable, selected.objects);
    const service = await fosGitObjectService(source.root, {
      env: source.env, idleMs: 120_000
    });
    // Worker startup, repository profile and discovery are outside the warm-worker boundary.
    const warmBody = await service.read(source.oids[0]);
    assert.ok(warmBody?.bytes.equals(source.expectedByOid.get(source.oids[0])));
    const cold = [], reference = [], asyncReference = [], persistent = [], persistentBatch = [];
    for (let trial = 0; trial < selected.samples; trial += 1) {
      cold.push(await coldRuntimeSample(source.root, source.env));
      reference.push(referenceSample(executable, source));
      asyncReference.push(await asyncReferenceSample(executable, source));
      persistent.push(await persistentSample(service, source));
      persistentBatch.push(await persistentBatchSample(service, source));
    }
    const sourceRevision = String(git(executable, ['rev-parse', 'HEAD'], {
      cwd: SOURCE_ROOT, env: source.env
    })).trim();
    const dirty = String(git(executable, ['status', '--porcelain'], {
      cwd: SOURCE_ROOT, env: source.env
    })).length > 0;
    const filesystem = await statfs(source.root);
    const report = {
      schema: 'sflow-gal-read-benchmark/v1',
      authority: 'local-measurement-only', lifecycleGate: false,
      platform: process.platform, architecture: process.arch,
      osRelease: os.release(), nodeVersion: process.versions.node, gitVersion,
      filesystemType: filesystem.type,
      sourceRevision, sourceDirty: dirty,
      fixture: {
        objectCount: selected.objects, objectBytes: OBJECT_BYTES,
        totalBytes: selected.objects * OBJECT_BYTES,
        oidListSha256: source.fixtureSha256,
        generated: true, repositoryState: 'unborn-with-staged-objects'
      },
      command: `node scripts/gal-read-benchmark.mjs --samples=${selected.samples} --objects=${selected.objects}`,
      objectServiceCapabilities: service.capabilities,
      // These two keys remain for v1 report-reader compatibility. The display names and embedded
      // protocol evidence are authoritative; a capability-selected worker is not necessarily the
      // legacy protocol named by the historical key.
      profileDisplayNames: {
        warmLegacyBatchWorker: 'Warm capability-selected persistent worker',
        warmExplicitMultiFrameBatchWorker:
          'Warm capability-selected persistent multi-frame batch'
      },
      profiles: {
        coldRuntimeAndRepositoryDiscovery: summarize(cold, selected.samples),
        referenceMetadataFirstSynchronousBatch: summarize(reference, selected.samples),
        referenceMetadataFirstAsyncBatch: summarize(asyncReference, selected.samples),
        warmLegacyBatchWorker: summarize(persistent, selected.samples, {
          persistentProtocol: service.capabilities.selectedProtocol
        }),
        warmExplicitMultiFrameBatchWorker: summarize(persistentBatch, selected.samples, {
          persistentProtocol: service.capabilities.selectedProtocol
        })
      },
      parity: { referenceExactBytes: true, asyncReferenceExactBytes: true,
        persistentExactBytes: true, persistentBatchExactBytes: true,
        requiredComplete: true },
      declaredFixtureComplete: selected.objects === 500,
      releaseQualified: false,
      exclusions: [
        'fixture setup, capability probe, and worker warmup excluded from timed read profiles',
        'cold profile starts new facade instances within an already-running Node process',
        'reference helper performs its own object-format discovery',
        `warm worker protocol selected by capability probe: ${service.capabilities.selectedProtocol}`,
        'explicit multi-frame batches use at most 128 OIDs per stdin write',
        'no Windows or Linux claim from this host',
        'not an end-to-end lifecycle or remote-authority benchmark'
      ]
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await closeFosGitObjectServices();
    await rm(base, { recursive: true, force: true });
  }
}

function summarize(samples, count, metadata = {}) {
  return {
    trials: count,
    ...metadata,
    latencyMilliseconds: distribution(samples.map((sample) => sample.milliseconds)),
    physicalGitSpawns: samples.map((sample) => sample.gitSpawns),
    ...(samples.some((sample) => 'logicalRequests' in sample)
      ? { logicalRequests: samples.map((sample) => sample.logicalRequests ?? 0) } : {}),
    ...(samples.some((sample) => 'workerSpawns' in sample)
      ? { workerSpawns: samples.map((sample) => sample.workerSpawns) } : {}),
    ...(samples.some((sample) => 'workerWrites' in sample)
      ? { workerWrites: samples.map((sample) => sample.workerWrites) } : {}),
    ...(samples.some((sample) => 'logicalObjectReads' in sample)
      ? { logicalObjectReads: samples.map((sample) => sample.logicalObjectReads) } : {})
  };
}

main().catch((error) => {
  // Never relay tool stderr, fixture paths, environment, or raw object bytes in a report.
  console.error(JSON.stringify({ schema: 'sflow-gal-read-benchmark/v1', status: 'failed',
    code: typeof error?.code === 'string' ? error.code : 'GAL_BENCHMARK_FAILED' }));
  process.exitCode = 1;
});
