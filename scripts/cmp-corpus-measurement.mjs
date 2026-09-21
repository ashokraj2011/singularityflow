#!/usr/bin/env node
/**
 * Privacy-safe CMP measurement over explicitly reviewed real-repository cases.
 *
 * V2 consumes a closed private manifest, checks the exact reviewed change-set subject and resource
 * classifications, and emits only aggregate mismatch counters. The legacy v1 --repository form is
 * retained as an explicitly unreviewed local measurement; it cannot claim reviewed-corpus evidence.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  buildChangeRegionManifest, evaluateComprehensionCoverage
} from '../src/comprehension/contracts.mjs';
import { buildComprehensionRecordPreview } from '../src/comprehension/record-preview.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';

const MAX_REPOSITORIES = 16;
const MAX_CASES = 64;
const MAX_SAMPLES = 20;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_RESOURCES_PER_CASE = 5_000;
const MAX_TOTAL_RESOURCES = 10_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const OPERATIONS = new Set(['added', 'copied', 'deleted', 'modified', 'renamed', 'type-changed']);
const CLASSIFICATIONS = new Set(['material', 'nonmaterial']);
const VERDICTS = new Set(['complete', 'incomplete', 'not-applicable']);

// The runner owns this short-lived process. Apply the noninteractive/no-refresh boundary to the
// repository-change-set implementation as well as the explicit validation probes below.
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GCM_INTERACTIVE = 'Never';
process.env.GIT_OPTIONAL_LOCKS = '0';
// Exact reviewed subjects must not be rewritten through refs/replace, and a partial clone must
// fail locally rather than silently fetching an object from its promisor remote.
process.env.GIT_NO_REPLACE_OBJECTS = '1';
process.env.GIT_NO_LAZY_FETCH = '1';
const GIT_ENVIRONMENT = Object.freeze({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1'
});

function fail(message) {
  throw new Error(`CMP_REAL_CORPUS_INVALID: ${message}`);
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function exactKeys(value, keys) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
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
  const parsed = {
    repositories: [], samples: 3, base: 'HEAD', baseSupplied: false, manifest: null
  };
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
      if (parsed.baseSupplied) fail('--base may be provided at most once.');
      parsed.base = base.value;
      parsed.baseSupplied = true;
      index = base.next;
      continue;
    }
    const manifest = optionValue(argv, index, 'manifest');
    if (manifest) {
      if (parsed.manifest != null) fail('--manifest may be provided exactly once.');
      parsed.manifest = manifest.value;
      index = manifest.next;
      continue;
    }
    fail(`unknown option at argument ${index - 1}.`);
  }
  if (!Number.isInteger(parsed.samples) || parsed.samples < 1 || parsed.samples > MAX_SAMPLES) {
    fail(`--samples must be an integer from 1 to ${MAX_SAMPLES}.`);
  }
  if (parsed.manifest != null) {
    if (parsed.repositories.length || parsed.baseSupplied) {
      fail('--manifest cannot be combined with --repository or --base.');
    }
    if (!parsed.manifest || Buffer.byteLength(parsed.manifest, 'utf8') > 4096
        || /[\0\r\n]/u.test(parsed.manifest)) {
      fail('--manifest path is invalid.');
    }
    return { mode: 'reviewed-v2', manifest: parsed.manifest, samples: parsed.samples };
  }
  if (parsed.repositories.length < 1 || parsed.repositories.length > MAX_REPOSITORIES) {
    fail(`provide 1 to ${MAX_REPOSITORIES} --repository values, or one --manifest.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,255}$/u.test(parsed.base)
      || parsed.base.includes('..')) {
    fail('--base must be one bounded Git commit revision, not an option or range.');
  }
  return {
    mode: 'legacy-v1', repositories: parsed.repositories, samples: parsed.samples, base: parsed.base
  };
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

function safeRelativePath(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 4096
      || value !== value.normalize('NFC') || /[\0\r\n]/u.test(value) || value.includes('\\')
      || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
      || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function resourceKey(resource) {
  return JSON.stringify([resource.pathBefore, resource.pathAfter, resource.operation]);
}

function compareResources(left, right) {
  return compareText(left.pathBefore ?? '', right.pathBefore ?? '')
    || compareText(left.pathAfter ?? '', right.pathAfter ?? '')
    || compareText(left.operation, right.operation);
}

function normalizeExpectedResource(value, caseIndex, resourceIndex) {
  const label = `manifest case ${caseIndex + 1} resource ${resourceIndex + 1}`;
  if (!exactKeys(value, ['classification', 'operation', 'pathAfter', 'pathBefore'])) {
    fail(`${label} has an invalid closed shape.`);
  }
  if (!OPERATIONS.has(value.operation)) fail(`${label} operation is unsupported.`);
  if (!CLASSIFICATIONS.has(value.classification)) fail(`${label} classification is invalid.`);
  const resource = {
    pathBefore: safeRelativePath(value.pathBefore, `${label} pathBefore`),
    pathAfter: safeRelativePath(value.pathAfter, `${label} pathAfter`),
    operation: value.operation,
    classification: value.classification
  };
  if (resource.pathBefore == null && resource.pathAfter == null) {
    fail(`${label} must identify a before or after resource.`);
  }
  if ((resource.operation === 'added' && resource.pathBefore !== null)
      || (resource.operation === 'deleted' && resource.pathAfter !== null)
      || (!['added', 'deleted'].includes(resource.operation)
        && (resource.pathBefore === null || resource.pathAfter === null))) {
    fail(`${label} paths do not match its operation.`);
  }
  return resource;
}

function normalizeReviewedManifest(value) {
  if (!exactKeys(value, ['cases', 'schema'])
      || value.schema !== 'sflow-cmp-real-corpus-input/v2'
      || !Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > MAX_CASES) {
    fail(`manifest must contain 1 to ${MAX_CASES} cases in the v2 closed shape.`);
  }
  const cases = [];
  const caseIds = new Set();
  let totalResources = 0;
  for (let caseIndex = 0; caseIndex < value.cases.length; caseIndex += 1) {
    const entry = value.cases[caseIndex];
    if (!exactKeys(entry, ['base', 'caseId', 'expected', 'repository'])
        || typeof entry.caseId !== 'string' || !CASE_ID.test(entry.caseId)
        || typeof entry.repository !== 'string' || !path.isAbsolute(entry.repository)
        || Buffer.byteLength(entry.repository, 'utf8') > 4096 || /[\0\r\n]/u.test(entry.repository)
        || typeof entry.base !== 'string' || !GIT_OBJECT_ID.test(entry.base)
        || !exactKeys(entry.expected, ['changeSetSha256', 'resources', 'verdict'])
        || typeof entry.expected.changeSetSha256 !== 'string'
        || !SHA256.test(entry.expected.changeSetSha256)
        || !VERDICTS.has(entry.expected?.verdict)
        || !Array.isArray(entry.expected?.resources)
        || entry.expected.resources.length > MAX_RESOURCES_PER_CASE) {
      fail(`manifest case ${caseIndex + 1} has an invalid closed shape.`);
    }
    if (caseIds.has(entry.caseId)) fail(`manifest case ${caseIndex + 1} repeats a case ID.`);
    caseIds.add(entry.caseId);
    const resources = entry.expected.resources.map((resource, resourceIndex) => (
      normalizeExpectedResource(resource, caseIndex, resourceIndex)
    ));
    totalResources += resources.length;
    if (totalResources > MAX_TOTAL_RESOURCES) {
      fail(`manifest exceeds the ${MAX_TOTAL_RESOURCES}-resource ceiling.`);
    }
    const keys = new Set();
    let previous = null;
    for (const resource of resources) {
      const key = resourceKey(resource);
      if (keys.has(key)) fail(`manifest case ${caseIndex + 1} repeats a resource expectation.`);
      keys.add(key);
      if (previous && compareResources(previous, resource) > 0) {
        fail(`manifest case ${caseIndex + 1} resources are not in canonical order.`);
      }
      previous = resource;
    }
    cases.push({
      caseId: entry.caseId,
      repository: entry.repository,
      base: entry.base,
      expected: {
        changeSetSha256: entry.expected.changeSetSha256,
        verdict: entry.expected.verdict,
        resources
      }
    });
  }
  for (let index = 1; index < cases.length; index += 1) {
    if (compareText(cases[index - 1].caseId, cases[index].caseId) >= 0) {
      fail('manifest cases are not in canonical caseId order.');
    }
  }
  return cases;
}

async function readReviewedManifest(input) {
  let handle;
  let resolved;
  let opened;
  try {
    const supplied = await lstat(input);
    if (!supplied.isFile() || supplied.isSymbolicLink()) fail('manifest must be an ordinary file.');
    resolved = await realpath(input);
    handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size < 1
        || opened.size > MAX_MANIFEST_BYTES || opened.dev !== supplied.dev || opened.ino !== supplied.ino) {
      fail('manifest must be one bounded ordinary file.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('manifest changed while it was read.');
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('manifest must be valid UTF-8 JSON.'); }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { fail('manifest must be valid UTF-8 JSON.'); }
    return {
      path: resolved,
      identity: {
        dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs,
        sha256: createHash('sha256').update(bytes).digest('hex')
      },
      cases: normalizeReviewedManifest(parsed)
    };
  } catch (error) {
    if (String(error?.message ?? '').startsWith('CMP_REAL_CORPUS_INVALID:')) throw error;
    fail('manifest could not be read safely.');
  } finally {
    await handle?.close();
  }
}

async function assertManifestUnchanged(manifest) {
  let handle;
  try {
    const current = await lstat(manifest.path);
    handle = await open(manifest.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || opened.dev !== manifest.identity.dev || opened.ino !== manifest.identity.ino
        || opened.size !== manifest.identity.size || opened.mtimeMs !== manifest.identity.mtimeMs
        || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || bytes.length !== opened.size
        || createHash('sha256').update(bytes).digest('hex') !== manifest.identity.sha256) {
      fail('manifest changed while the corpus was measured.');
    }
  } catch (error) {
    if (String(error?.message ?? '').startsWith('CMP_REAL_CORPUS_INVALID:')) throw error;
    fail('manifest changed while the corpus was measured.');
  } finally {
    await handle?.close();
  }
}

function containsPath(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

async function verifiedReviewedCases(manifest) {
  const roots = new Set();
  const selections = new Set();
  const cases = [];
  for (let index = 0; index < manifest.cases.length; index += 1) {
    const entry = manifest.cases[index];
    try {
      const canonical = await realpath(entry.repository);
      if (!(await lstat(canonical)).isDirectory()) {
        fail(`manifest case ${index + 1} repository is not an exact ordinary directory.`);
      }
      const top = await realpath(gitText(canonical, ['rev-parse', '--show-toplevel']));
      if (top !== canonical) fail(`manifest case ${index + 1} repository is not an exact Git root.`);
      const base = gitText(canonical, ['rev-parse', '--verify', `${entry.base}^{commit}`]);
      if (base !== entry.base) fail(`manifest case ${index + 1} base is not one exact commit object ID.`);
      if (containsPath(canonical, manifest.path)) {
        fail(`manifest case ${index + 1} stores the private review manifest inside its repository.`);
      }
      const selection = `${canonical}\0${base}`;
      if (selections.has(selection)) fail(`manifest case ${index + 1} repeats a repository/base selection.`);
      selections.add(selection);
      roots.add(canonical);
      if (roots.size > MAX_REPOSITORIES) {
        fail(`manifest exceeds the ${MAX_REPOSITORIES}-repository ceiling.`);
      }
      cases.push({ ...entry, repository: canonical, base });
    } catch (error) {
      if (String(error?.message ?? '').startsWith('CMP_REAL_CORPUS_INVALID:')) throw error;
      fail(`manifest case ${index + 1} could not be verified without network access.`);
    }
  }
  return { cases, repositories: [...roots] };
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

function increment(target, key, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)));
}

function measurementState() {
  return {
    timings: { changeSet: [], regionProjection: [], coverageEvaluation: [], total: [], cpu: [] },
    storage: { manifest: [], coverage: [], recordModePreview: [] },
    counts: {
      casesWithChanges: 0,
      casesWithoutChanges: 0,
      regions: 0,
      materialRegions: 0,
      unresolved: 0,
      diagnostics: 0,
      unresolvedByCode: {},
      diagnosticsByCode: {}
    }
  };
}

async function measureCase(repository, base, samples, state, onSample = null) {
  let finalChangeSet;
  let finalManifest;
  let finalCoverage;
  let finalPreview;
  for (let sample = 0; sample < samples; sample += 1) {
    const totalStartedAt = performance.now();
    const cpuStarted = process.cpuUsage();
    const changeSetStartedAt = performance.now();
    const changeSet = await buildRepositoryChangeSet(repository, {
      baseCommit: base,
      subject: { kind: 'comprehension-observation', workId: null, phase: null }
    });
    finalChangeSet = changeSet;
    state.timings.changeSet.push(performance.now() - changeSetStartedAt);

    const manifestStartedAt = performance.now();
    finalManifest = buildChangeRegionManifest(changeSet);
    state.timings.regionProjection.push(performance.now() - manifestStartedAt);

    const coverageStartedAt = performance.now();
    finalCoverage = evaluateComprehensionCoverage({ changeSet, manifest: finalManifest });
    finalPreview = buildComprehensionRecordPreview({ manifest: finalManifest, coverage: finalCoverage });
    state.timings.coverageEvaluation.push(performance.now() - coverageStartedAt);
    state.timings.total.push(performance.now() - totalStartedAt);
    const cpu = process.cpuUsage(cpuStarted);
    state.timings.cpu.push((cpu.user + cpu.system) / 1_000);
    onSample?.({ changeSet, manifest: finalManifest, coverage: finalCoverage });
  }

  const regionCount = finalManifest.counts.regions;
  state.counts.casesWithChanges += regionCount > 0 ? 1 : 0;
  state.counts.casesWithoutChanges += regionCount === 0 ? 1 : 0;
  state.counts.regions += regionCount;
  state.counts.materialRegions += finalCoverage.counts.materialRegions;
  state.counts.unresolved += finalCoverage.counts.unresolved;
  state.counts.diagnostics += finalCoverage.counts.diagnostics;
  incrementByCode(state.counts.unresolvedByCode, finalCoverage.unresolved);
  incrementByCode(state.counts.diagnosticsByCode, finalCoverage.diagnostics);
  state.storage.manifest.push(Buffer.byteLength(JSON.stringify(finalManifest), 'utf8'));
  state.storage.coverage.push(Buffer.byteLength(JSON.stringify(finalCoverage), 'utf8'));
  state.storage.recordModePreview.push(Buffer.byteLength(JSON.stringify(finalPreview), 'utf8'));
  return { changeSetSha256: finalChangeSet.digest, manifest: finalManifest, coverage: finalCoverage };
}

function metrics(state) {
  return {
    timingsMilliseconds: Object.fromEntries(
      Object.entries(state.timings).map(([name, values]) => [name, distribution(values)])
    ),
    counts: {
      ...state.counts,
      unresolvedByCode: sortedCounts(state.counts.unresolvedByCode),
      diagnosticsByCode: sortedCounts(state.counts.diagnosticsByCode)
    },
    storageBytesPerCase: Object.fromEntries(
      Object.entries(state.storage).map(([name, values]) => [name, distribution(values)])
    )
  };
}

function commonReportFields() {
  return {
    authority: 'none',
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    availability: {
      exactRepositoryChangeSet: 'available',
      structuralExtraction: 'not-invoked',
      model: 'not-invoked',
      network: 'not-invoked',
      cache: 'not-used-observe-only'
    },
    repositoryState: 'unchanged-observed',
    lifecycleGate: false,
    authoritative: false
  };
}

async function legacyReport(requested) {
  const repositories = await verifiedRepositories(requested.repositories, requested.base);
  const state = measurementState();
  for (let repositoryIndex = 0; repositoryIndex < repositories.length; repositoryIndex += 1) {
    const repository = repositories[repositoryIndex];
    const before = repositoryStateFingerprint(repository);
    try {
      await measureCase(repository, requested.base, requested.samples, state);
      if (repositoryStateFingerprint(repository) !== before) {
        fail(`repository input ${repositoryIndex + 1} changed while it was measured.`);
      }
    } catch (error) {
      if (String(error?.message ?? '').startsWith('CMP_REAL_CORPUS_INVALID:')) throw error;
      fail(`repository input ${repositoryIndex + 1} could not be measured safely.`);
    }
  }
  const measured = metrics(state);
  const counts = {
    ...measured.counts,
    repositoriesWithChanges: measured.counts.casesWithChanges,
    repositoriesWithoutChanges: measured.counts.casesWithoutChanges
  };
  delete counts.casesWithChanges;
  delete counts.casesWithoutChanges;
  return {
    schema: 'sflow-cmp-real-corpus/v1',
    assurance: 'content-free-local-measurement',
    ...commonReportFields(),
    corpusProfile: 'operator-selected-real-repositories-v1',
    inputBinding: 'operator-reviewed-out-of-band',
    repositoryCount: repositories.length,
    requestedSamplesPerRepository: requested.samples,
    completedMeasurements: repositories.length * requested.samples,
    outcome: counts.repositoriesWithChanges > 0 ? 'observed' : 'no-changes',
    timingsMilliseconds: measured.timingsMilliseconds,
    counts,
    storageBytesPerRepository: measured.storageBytesPerCase,
    contentExcluded: [
      'repository-path', 'file-path', 'content-digest', 'source-bytes', 'cause-statement',
      'work-id', 'git-identity', 'prompt', 'transcript'
    ]
  };
}

function observedResource(region) {
  return {
    pathBefore: region.location?.pathBefore ?? null,
    pathAfter: region.location?.pathAfter ?? null,
    operation: region.operation,
    classification: region.classification?.material === true ? 'material' : 'nonmaterial'
  };
}

export function compareReviewedExpectation(entry, manifest, coverage, subjectDriftObserved = false) {
  const expectedResources = new Map(entry.expected.resources.map((resource) => [
    resourceKey(resource), resource
  ]));
  const observedResources = new Map(manifest.regions.map((region) => {
    const resource = observedResource(region);
    return [resourceKey(resource), resource];
  }));
  const result = {
    subjectMismatches: subjectDriftObserved || manifest.changeSetSha256 !== entry.expected.changeSetSha256 ? 1 : 0,
    verdictMismatches: coverage.verdict === entry.expected.verdict ? 0 : 1,
    falseComplete: coverage.verdict === 'complete' && entry.expected.verdict !== 'complete' ? 1 : 0,
    falseIncomplete: coverage.verdict === 'incomplete' && entry.expected.verdict === 'complete' ? 1 : 0,
    otherVerdictMismatches: 0,
    missingExpectedResources: 0,
    unexpectedObservedResources: 0,
    falseMaterial: 0,
    falseNonmaterial: 0
  };
  if (result.verdictMismatches && !result.falseComplete && !result.falseIncomplete) {
    result.otherVerdictMismatches = 1;
  }
  for (const [key, expected] of expectedResources) {
    const observed = observedResources.get(key);
    if (!observed) {
      result.missingExpectedResources += 1;
      continue;
    }
    if (observed.classification === 'material' && expected.classification === 'nonmaterial') {
      result.falseMaterial += 1;
    } else if (observed.classification === 'nonmaterial' && expected.classification === 'material') {
      result.falseNonmaterial += 1;
    }
  }
  for (const key of observedResources.keys()) {
    if (!expectedResources.has(key)) result.unexpectedObservedResources += 1;
  }
  const mismatch = Object.values(result).some((count) => count > 0);
  return { ...result, mismatch };
}

async function reviewedReport(requested) {
  const manifestInput = await readReviewedManifest(requested.manifest);
  const reviewed = await verifiedReviewedCases(manifestInput);
  const state = measurementState();
  const repositoryStates = new Map(reviewed.repositories.map((repository) => [
    repository, repositoryStateFingerprint(repository)
  ]));
  const expectedVerdicts = { complete: 0, incomplete: 0, 'not-applicable': 0 };
  const observedVerdicts = { complete: 0, incomplete: 0, 'not-applicable': 0 };
  const reviewedClassifications = { material: 0, nonmaterial: 0 };
  const observedSubjects = [];
  const mismatches = {
    cases: 0,
    subject: 0,
    verdict: 0,
    falseComplete: 0,
    falseIncomplete: 0,
    otherVerdict: 0,
    resourceInventory: 0,
    missingExpectedResources: 0,
    unexpectedObservedResources: 0,
    classification: 0,
    falseMaterial: 0,
    falseNonmaterial: 0
  };

  for (let caseIndex = 0; caseIndex < reviewed.cases.length; caseIndex += 1) {
    const entry = reviewed.cases[caseIndex];
    let subjectDriftObserved = false;
    try {
      const result = await measureCase(
        entry.repository, entry.base, requested.samples, state,
        ({ changeSet }) => {
          if (changeSet.digest !== entry.expected.changeSetSha256) subjectDriftObserved = true;
        }
      );
      if (repositoryStateFingerprint(entry.repository) !== repositoryStates.get(entry.repository)) {
        fail(`manifest case ${caseIndex + 1} repository changed while it was measured.`);
      }
      increment(expectedVerdicts, entry.expected.verdict);
      increment(observedVerdicts, result.coverage.verdict);
      for (const resource of entry.expected.resources) increment(reviewedClassifications, resource.classification);
      const comparison = compareReviewedExpectation(
        entry, result.manifest, result.coverage, subjectDriftObserved
      );
      observedSubjects.push({ entry, changeSetSha256: result.changeSetSha256 });
      mismatches.cases += comparison.mismatch ? 1 : 0;
      mismatches.subject += comparison.subjectMismatches;
      mismatches.verdict += comparison.verdictMismatches;
      mismatches.falseComplete += comparison.falseComplete;
      mismatches.falseIncomplete += comparison.falseIncomplete;
      mismatches.otherVerdict += comparison.otherVerdictMismatches;
      mismatches.missingExpectedResources += comparison.missingExpectedResources;
      mismatches.unexpectedObservedResources += comparison.unexpectedObservedResources;
      mismatches.resourceInventory += comparison.missingExpectedResources
        + comparison.unexpectedObservedResources;
      mismatches.falseMaterial += comparison.falseMaterial;
      mismatches.falseNonmaterial += comparison.falseNonmaterial;
      mismatches.classification += comparison.falseMaterial + comparison.falseNonmaterial;
    } catch (error) {
      if (String(error?.message ?? '').startsWith('CMP_REAL_CORPUS_INVALID:')) throw error;
      fail(`manifest case ${caseIndex + 1} could not be measured safely.`);
    }
  }
  await assertManifestUnchanged(manifestInput);
  for (let caseIndex = 0; caseIndex < observedSubjects.length; caseIndex += 1) {
    const observed = observedSubjects[caseIndex];
    try {
      const current = await buildRepositoryChangeSet(observed.entry.repository, {
        baseCommit: observed.entry.base,
        subject: { kind: 'comprehension-observation', workId: null, phase: null }
      });
      if (current.digest !== observed.changeSetSha256) {
        fail(`manifest case ${caseIndex + 1} exact subject changed after measurement.`);
      }
    } catch (error) {
      if (String(error?.message ?? '').startsWith('CMP_REAL_CORPUS_INVALID:')) throw error;
      fail(`manifest case ${caseIndex + 1} exact subject could not be rechecked safely.`);
    }
  }
  for (const [repository, before] of repositoryStates) {
    if (repositoryStateFingerprint(repository) !== before) {
      fail('a selected repository changed while the reviewed corpus was measured.');
    }
  }

  const measured = metrics(state);
  return {
    schema: 'sflow-cmp-real-corpus/v2',
    assurance: 'content-free-local-reviewed-expectation-comparison',
    ...commonReportFields(),
    corpusProfile: 'operator-supplied-reviewed-expectations-v2',
    inputBinding: 'exact-change-set-and-resource-expectations',
    reviewAuthentication: 'not-performed',
    independentReview: 'not-proven-by-runner',
    repositoryCount: reviewed.repositories.length,
    caseCount: reviewed.cases.length,
    requestedSamplesPerCase: requested.samples,
    completedMeasurements: reviewed.cases.length * requested.samples,
    outcome: mismatches.cases > 0 ? 'mismatch' : 'observed',
    timingsMilliseconds: measured.timingsMilliseconds,
    counts: {
      ...measured.counts,
      expectedVerdicts: sortedCounts(expectedVerdicts),
      observedVerdicts: sortedCounts(observedVerdicts),
      reviewedClassifications: sortedCounts(reviewedClassifications),
      mismatches
    },
    storageBytesPerCase: measured.storageBytesPerCase,
    contentExcluded: [
      'manifest-path', 'case-id', 'repository-path', 'base-commit', 'file-path',
      'change-set-digest', 'content-digest', 'source-bytes', 'cause-statement', 'work-id',
      'git-identity', 'prompt', 'transcript'
    ]
  };
}

async function main() {
  const requested = argumentsFrom(process.argv);
  const report = requested.mode === 'reviewed-v2'
    ? await reviewedReport(requested)
    : await legacyReport(requested);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (requested.mode === 'reviewed-v2' && report.outcome === 'mismatch') {
    process.stderr.write('CMP_REAL_CORPUS_MISMATCH: reviewed expectations did not match the observation.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = String(error?.message ?? 'CMP_REAL_CORPUS_INVALID: measurement failed.');
    process.stderr.write(`${message.startsWith('CMP_REAL_CORPUS_INVALID:')
      ? message
      : 'CMP_REAL_CORPUS_INVALID: measurement failed safely.'}\n`);
    process.exitCode = 2;
  });
}
