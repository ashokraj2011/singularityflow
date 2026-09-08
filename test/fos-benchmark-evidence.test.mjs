import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fosBenchmarkReportSha256, registerFosBenchmarkEvidence, validateFosBenchmarkEvidence
} from '../src/fos-benchmark-evidence.mjs';
import { FOS_FEATURE_DEFAULTS } from '../src/fos-features.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';

const sourceManifest = new URL('../benchmarks/fos/benchmark-manifest.json', import.meta.url);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const registeredDarwinEvidence = new URL(
  '../benchmarks/fos/evidence/darwin-arm64-ashok-m4-local-5430fd35a351.json', import.meta.url
);
const digest = `sha256:${'a'.repeat(64)}`;

function git(root, ...arguments_) {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' }).trim();
}

function reportFor(manifest, commit) {
  const controlled = manifest.profiles.controlled;
  const records = Array.from({ length: controlled.minimumSamples }, (_, index) => ({
    sample: index + 1,
    optimized: { warmMs: 1, warmRequestCount: 0, warmSpawnCount: 0 },
    semanticEquivalent: true
  }));
  const fixtures = Object.entries(controlled.fixtures).map(([id, definition]) => ({
    id, definition, hashes: { definitionSha256: digest, stateSha256: digest },
    samples: controlled.minimumSamples, warmupRuns: controlled.warmupRuns,
    records, summary: { semanticEquivalent: true }
  }));
  fixtures.push({
    id: 'linked-worktrees', definition: { trackedFiles: 64 },
    hashes: { definitionSha256: digest, stateSha256: digest },
    samples: controlled.minimumSamples, records, summary: { semanticEquivalent: true }
  });
  const report = {
    schemaVersion: currentSchemaVersion('fos-benchmark-report'),
    kind: 'fos-local-benchmark-report', claimsAuthorized: false,
    profile: 'controlled',
    binding: { implementationCommit: commit, workingTree: 'clean', hashBound: true },
    runner: {
      identity: 'controlled-test-runner', platform: 'darwin', architecture: 'arm64',
      node: '22.14.0', git: '2.54.0', osRelease: 'test-release', cpu: 'Test CPU',
      memoryBytes: 1024, storageClass: 'local-ssd', filesystem: 'apfs', powerMode: 'ac'
    },
    featureState: FOS_FEATURE_DEFAULTS,
    manifest: {
      schemaVersion: manifest.schemaVersion,
      specificationSha256: manifest.specificationSha256,
      budgets: manifest.budgets
    },
    coverage: {
      localFixtures: fixtures.map((entry) => entry.id),
      externallyMeasuredCommands: ['existing-local-authority-onboard'],
      notMeasured: ['controlled-network-completion']
    },
    evaluation: { checks: { local: true }, status: 'passed' },
    fixtures,
    externalCommands: [{
      id: 'existing-local-authority-onboard',
      hashes: { definitionSha256: digest, stateSha256: digest },
      samples: controlled.minimumSamples, warmupRuns: controlled.warmupRuns,
      records: records.map((entry) => ({
        sample: entry.sample, externalWallMs: 10, firstFeedbackMs: 5, completed: true,
        counters: {
          discoveryCalls: 0, compositionCalls: 0, llmCalls: 0, astCalls: 0
        }
      })),
      summary: { allCompleted: true, forbiddenWorkCalls: [0] }
    }]
  };
  report.reportSha256 = fosBenchmarkReportSha256(report);
  return report;
}

test('controlled FOS evidence registration is exact-commit-bound, content-safe, and immutable', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-evidence-'));
  const root = path.join(parent, 'repository');
  await mkdir(path.join(root, 'benchmarks', 'fos'), { recursive: true });
  git(parent, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'FOS Evidence');
  git(root, 'config', 'user.email', 'fos-evidence@example.invalid');
  const manifestText = await readFile(sourceManifest, 'utf8');
  await writeFile(path.join(root, 'benchmarks', 'fos', 'benchmark-manifest.json'), manifestText);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const manifest = JSON.parse(manifestText);
  const report = reportFor(manifest, git(root, 'rev-parse', 'HEAD'));
  const input = path.join(parent, 'controlled.json');
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(input, serialized);
  try {
    assert.equal((await validateFosBenchmarkEvidence(root, serialized)).reportSha256,
      report.reportSha256);
    const registered = await registerFosBenchmarkEvidence(root, input);
    assert.equal(registered.status, 'registered');
    assert.equal(await readFile(path.join(root, registered.path), 'utf8'), serialized);
    assert.equal((await registerFosBenchmarkEvidence(root, input)).status, 'current');
    const tampered = structuredClone(report);
    tampered.runner.cpu = '/Users/example/private';
    tampered.reportSha256 = fosBenchmarkReportSha256(tampered);
    await assert.rejects(
      () => validateFosBenchmarkEvidence(root, JSON.stringify(tampered)),
      (error) => error.code === 'FOS_BENCHMARK_EVIDENCE_INVALID'
    );
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('registered Darwin FOS evidence remains verifiable against its historical manifest', async () => {
  const serialized = await readFile(registeredDarwinEvidence, 'utf8');
  const report = await validateFosBenchmarkEvidence(repositoryRoot, serialized);
  assert.equal(report.binding.implementationCommit,
    '5430fd35a3516ffb846f94814f79cf95c8bbb61a');
  assert.equal(report.evaluation.status, 'passed');
  assert.equal(report.fixtures.find((entry) => entry.id === 'reference-local')
    .summary.optimizedWarmGitRequests[0], 0);
  assert.ok(report.coverage.notMeasured.includes('office-remote'));
  assert.equal(report.claimsAuthorized, false);
});
