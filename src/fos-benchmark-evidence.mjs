import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FOS_FEATURE_DEFAULTS } from './fos-features.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function refuse(message) {
  const error = new Error(message);
  error.code = 'FOS_BENCHMARK_EVIDENCE_INVALID';
  throw error;
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validDigest(value) {
  return /^sha256:[a-f0-9]{64}$/.test(value ?? '');
}

function containsSensitiveLocator(value) {
  if (typeof value === 'string') {
    return /https?:\/\//i.test(value)
      || /(?:^|\s)(?:\/(?:Users|home)\/|[A-Za-z]:\\)/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsSensitiveLocator);
  return value && typeof value === 'object'
    ? Object.values(value).some(containsSensitiveLocator) : false;
}

function currentCommit(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function p95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export function fosBenchmarkReportSha256(report) {
  const copy = structuredClone(report);
  delete copy.reportSha256;
  return sha256(JSON.stringify(copy));
}

export async function validateFosBenchmarkEvidence(root, serialized) {
  let report;
  try { report = readRecord('fos-benchmark-report', JSON.parse(serialized)).record; }
  catch { refuse('The FOS benchmark evidence is not valid JSON.'); }
  const manifest = readRecord('fos-benchmark-manifest', await readFile(
    path.join(root, 'benchmarks', 'fos', 'benchmark-manifest.json'), 'utf8'
  ).then(JSON.parse)).record;
  const controlled = manifest.profiles?.controlled;
  const expectedFixtureIds = [...Object.keys(controlled?.fixtures ?? {}), 'linked-worktrees'];
  const expectedCommit = currentCommit(root);
  const nodeMajor = Number(String(report.runner?.node ?? '').split('.')[0]);
  const runnerFacts = ['identity', 'platform', 'architecture', 'node', 'git', 'osRelease', 'cpu',
    'storageClass', 'filesystem', 'powerMode'];
  const fixtures = new Map((report.fixtures ?? []).map((entry) => [entry?.id, entry]));
  const external = report.externalCommands?.find(
    (entry) => entry?.id === 'existing-local-authority-onboard'
  );
  const reference = fixtures.get('reference-local');
  const referenceBudget = manifest.budgets?.['reference-local'];
  const onboardBudget = manifest.budgets?.['existing-local-authority-onboard'];
  const referenceRecordsValid = reference?.records?.every((entry) => entry?.semanticEquivalent === true
    && Number.isFinite(entry.optimized?.warmMs)
    && entry.optimized.warmRequestCount <= referenceBudget.optimizedWarmGitRequests
    && entry.optimized.warmSpawnCount <= referenceBudget.optimizedWarmGitSpawns);
  const onboardRecordsValid = external?.records?.every((entry) => entry?.completed === true
    && Number.isFinite(entry.externalWallMs) && Number.isFinite(entry.firstFeedbackMs)
    && entry.externalWallMs >= 0 && entry.firstFeedbackMs >= 0
    && entry.counters?.discoveryCalls === 0 && entry.counters?.compositionCalls === 0
    && entry.counters?.llmCalls === 0 && entry.counters?.astCalls === 0);
  const expectedManifestBinding = {
    schemaVersion: currentSchemaVersion('fos-benchmark-manifest'),
    specificationSha256: manifest.specificationSha256,
    budgets: manifest.budgets
  };
  const invalid = report.kind !== 'fos-local-benchmark-report'
    || report.profile !== 'controlled'
    || report.claimsAuthorized !== false
    || report.binding?.implementationCommit !== expectedCommit
    || report.binding?.workingTree !== 'clean'
    || report.binding?.hashBound !== true
    || report.reportSha256 !== fosBenchmarkReportSha256(report)
    || !exactJson(report.manifest, expectedManifestBinding)
    || !manifest.requiredRuntime?.nodeMajors?.includes(nodeMajor)
    || !manifest.requiredRuntime?.platforms?.includes(report.runner?.platform)
    || !Number.isSafeInteger(report.runner?.memoryBytes) || report.runner.memoryBytes <= 0
    || runnerFacts.some((name) => !report.runner?.[name]
      || ['unknown', 'unreported', 'unclaimed-local'].includes(report.runner[name]))
    || !exactJson(report.featureState, FOS_FEATURE_DEFAULTS)
    || report.evaluation?.status !== 'passed'
    || Object.keys(report.evaluation?.checks ?? {}).length === 0
    || Object.values(report.evaluation?.checks ?? {}).some((value) => value !== true)
    || !exactJson(report.coverage?.localFixtures, expectedFixtureIds)
    || report.coverage?.externallyMeasuredCommands?.length !== 1
    || report.coverage.externallyMeasuredCommands[0] !== 'existing-local-authority-onboard'
    || expectedFixtureIds.some((id) => {
      const fixture = fixtures.get(id);
      const expected = controlled.fixtures[id];
      return !fixture || fixture.samples !== controlled.minimumSamples
        || fixture.records?.length !== controlled.minimumSamples
        || !validDigest(fixture.hashes?.definitionSha256)
        || !validDigest(fixture.hashes?.stateSha256)
        || (expected && !exactJson(fixture.definition, expected))
        || fixture.summary?.semanticEquivalent !== true;
    })
    || !external || external.samples !== controlled.minimumSamples
    || external.warmupRuns !== controlled.warmupRuns
    || external.records?.length !== controlled.minimumSamples
    || !validDigest(external.hashes?.definitionSha256)
    || !validDigest(external.hashes?.stateSha256)
    || external.summary?.allCompleted !== true
    || external.summary?.forbiddenWorkCalls?.some((count) => count !== 0)
    || !referenceRecordsValid
    || p95(reference?.records?.map((entry) => entry.optimized.warmMs) ?? [])
      > referenceBudget.optimizedWarmP95Ms
    || !onboardRecordsValid
    || p95(external?.records?.map((entry) => entry.externalWallMs) ?? [])
      > onboardBudget.externalWallP95Ms
    || p95(external?.records?.map((entry) => entry.firstFeedbackMs) ?? [])
      > onboardBudget.firstFeedbackP95Ms
    || containsSensitiveLocator(report);
  if (invalid) refuse(
    'The FOS report is not a complete, passing, content-safe controlled witness for this exact commit and manifest.'
  );
  return Object.freeze(report);
}

export async function registerFosBenchmarkEvidence(root, inputPath) {
  const absoluteRoot = path.resolve(root);
  const absoluteInput = path.resolve(inputPath);
  if (absoluteInput === absoluteRoot || absoluteInput.startsWith(`${absoluteRoot}${path.sep}`)) {
    refuse('Raw FOS benchmark output must be produced outside the repository before registration.');
  }
  const serialized = await readFile(absoluteInput, 'utf8');
  const report = await validateFosBenchmarkEvidence(absoluteRoot, serialized);
  const name = `${report.runner.platform}-${report.runner.architecture}-${report.runner.identity}-${report.binding.implementationCommit.slice(0, 12)}.json`;
  const directory = path.join(absoluteRoot, 'benchmarks', 'fos', 'evidence');
  const target = path.join(directory, name);
  await mkdir(directory, { recursive: true });
  const existing = await readFile(target, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing != null) {
    if (existing !== serialized) refuse('A different FOS evidence record already exists for this runner and commit.');
    return Object.freeze({ status: 'current', path: path.relative(absoluteRoot, target), report });
  }
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, serialized, { mode: 0o644 });
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return Object.freeze({ status: 'registered', path: path.relative(absoluteRoot, target), report });
}
