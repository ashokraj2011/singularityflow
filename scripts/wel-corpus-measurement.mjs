#!/usr/bin/env node
/**
 * Privacy-safe WEL JavaScript measurement over an explicitly reviewed real-repository corpus.
 *
 * The manifest is an operator input and may contain local paths. Output never repeats those paths,
 * source/report bytes, test names, clauses, identities, or content digests. This process invokes
 * no model, AST, network, lifecycle mutation, test command, or cache writer.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  replayLocalJavascriptJsonObservation, replayLocalJunitObservation
} from '../src/code-delivery-tests.mjs';
import { secureRepositoryPath } from '../src/util.mjs';
import { observeJavascriptTestIdentities } from '../src/wel-javascript.mjs';
import { observeJunit5SurefireIdentities } from '../src/wel-junit5.mjs';

const MAX_REPOSITORIES = 16;
const MAX_CASES = 64;
const MAX_SAMPLES = 20;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_FILES = 1_000;
const MAX_REPORT_DEPTH = 8;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_RELATIVE = /^(?:\.|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/;
const FRAMEWORKS = Object.freeze({
  jest: Object.freeze({
    family: 'javascript', reportKind: 'file', resultAdapter: 'jest-json',
    profile: 'jest-static-v1', argv: ['npm', 'test']
  }),
  vitest: Object.freeze({
    family: 'javascript', reportKind: 'file', resultAdapter: 'vitest-json',
    profile: 'vitest-static-v1', argv: ['npm', 'test']
  }),
  'junit-surefire': Object.freeze({
    family: 'junit', reportKind: 'directory', resultAdapter: 'junit-xml',
    profile: 'junit5-surefire-v1', argv: ['mvn', 'test']
  })
});
const EXPECTED_REASONS = new Set([
  'CODE_TEST_RESULT_REQUIRED',
  'FOCUSED_TEST_EXECUTION_UNSUPPORTED',
  'FOCUSED_OR_RETRIED_TEST_EXECUTION_UNSUPPORTED',
  'FRAMEWORK_RETRY_UNSUPPORTED',
  'JAVASCRIPT_SOURCE_CATALOG_UNAVAILABLE',
  'JAVASCRIPT_TEST_SOURCE_UNAVAILABLE',
  'JAVASCRIPT_TEST_SOURCES_UNAVAILABLE',
  'JUNIT_SOURCE_CATALOG_UNAVAILABLE',
  'JUNIT_SOURCE_NOT_UTF8',
  'JUNIT_SOURCE_PARSER_CANCELLED',
  'JUNIT_SOURCE_PARSER_MALFORMED',
  'JUNIT_SOURCE_PARSER_OUTPUT_LIMIT',
  'JUNIT_SOURCE_PARSER_TIMEOUT',
  'JUNIT_SOURCE_PARSER_UNAVAILABLE',
  'JUNIT_TEST_SOURCE_UNAVAILABLE',
  'JUNIT_TEST_SOURCES_UNAVAILABLE',
  'MAVEN_SUREFIRE_COMMAND_UNSUPPORTED',
  'REPOSITORY_IDENTITY_UNAVAILABLE',
  'REPORT_SOURCE_DECLARATION_UNMATCHED',
  'REPORT_TEST_IDENTITY_AMBIGUOUS',
  'SOURCE_PATH_INVALID',
  'TAGGED_TEST_DECLARATIONS_UNAVAILABLE',
  'TEST_DECLARATION_COLLISION',
  'TEST_SOURCE_CHANGED_DURING_CAPTURE',
  'TEST_SOURCE_LIMIT_EXCEEDED',
  'UNSUPPORTED_JUNIT5_SOURCE_SHAPE',
  'UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE',
  'WITNESS_MAPPING_COLLISION',
  'WITNESS_MAPPING_PROPOSALS_UNAVAILABLE'
]);

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
  throw new Error(`WEL_REAL_CORPUS_INVALID: ${message}`);
}

function parseArguments(argv) {
  let manifest = null;
  let samples = 3;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inline] = argument.split('=', 2);
    if (!['--manifest', '--samples'].includes(name)) fail(`unknown option at argument ${index - 1}.`);
    const value = inline ?? argv[index + 1];
    if (value == null || value.startsWith('--')) fail(`${name} requires a value.`);
    if (inline == null) index += 1;
    if (name === '--manifest') {
      if (manifest != null) fail('--manifest may be provided exactly once.');
      manifest = value;
    } else samples = Number(value);
  }
  if (!manifest || Buffer.byteLength(manifest, 'utf8') > 4096 || /[\0\r\n]/u.test(manifest)) {
    fail('provide one valid --manifest path.');
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) {
    fail(`--samples must be an integer from 1 to ${MAX_SAMPLES}.`);
  }
  return { manifest, samples };
}

async function readBoundedRegularFile(file, maximumBytes, label) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    const link = await lstat(file);
    if (!before.isFile() || link.isSymbolicLink() || before.nlink !== 1
        || link.dev !== before.dev || link.ino !== before.ino || before.size > maximumBytes) {
      fail(`${label} is not an admitted bounded regular file.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail(`${label} changed while it was read.`);
    }
    return bytes;
  } catch (error) {
    if (String(error?.message ?? '').startsWith('WEL_REAL_CORPUS_INVALID:')) throw error;
    fail(`${label} could not be read safely.`);
  } finally {
    await handle?.close();
  }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function normalizeRelative(value, label) {
  if (typeof value !== 'string' || !SAFE_RELATIVE.test(value) || value.includes('..')
      || value.includes('\\') || /[\0\r\n]/u.test(value)) fail(`${label} is invalid.`);
  return value;
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

async function validateManifest(input) {
  if (!exactKeys(input, ['schema', 'cases']) || input.schema !== 'sflow-wel-real-corpus-input/v1'
      || !Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > MAX_CASES) {
    fail(`manifest must contain 1 to ${MAX_CASES} cases in the v1 closed shape.`);
  }
  const caseIds = new Set();
  const repositoryRoots = new Map();
  const tuples = new Set();
  const cases = [];
  for (let index = 0; index < input.cases.length; index += 1) {
    const entry = input.cases[index];
    if (!exactKeys(entry, [
      'caseId', 'repository', 'framework', 'workingDirectory', 'report', 'expected'
    ]) || !CASE_ID.test(String(entry?.caseId ?? '')) || !Object.hasOwn(FRAMEWORKS, entry?.framework)
        || !exactKeys(entry?.expected, ['outcome', 'reason'])) {
      fail(`manifest case ${index + 1} has an invalid closed shape.`);
    }
    if (caseIds.has(entry.caseId)) fail(`manifest case ${index + 1} repeats a case ID.`);
    caseIds.add(entry.caseId);
    const outcome = entry.expected.outcome;
    const reason = entry.expected.reason;
    if (!['exact', 'inexact', 'report-refused'].includes(outcome)
        || (outcome === 'exact' ? reason !== null : !EXPECTED_REASONS.has(reason))
        || (outcome === 'report-refused' && reason !== 'CODE_TEST_RESULT_REQUIRED')) {
      fail(`manifest case ${index + 1} has an invalid expected outcome or reason.`);
    }
    if (typeof entry.repository !== 'string' || Buffer.byteLength(entry.repository, 'utf8') > 4096
        || /[\0\r\n]/u.test(entry.repository)) fail(`manifest case ${index + 1} repository is invalid.`);
    let root;
    try {
      root = await realpath(entry.repository);
      if (!(await lstat(root)).isDirectory()) fail(`manifest case ${index + 1} repository is invalid.`);
      const top = await realpath(gitText(root, ['rev-parse', '--show-toplevel']));
      if (root !== top) fail(`manifest case ${index + 1} repository is not an exact Git root.`);
    } catch (error) {
      if (String(error?.message ?? '').startsWith('WEL_REAL_CORPUS_INVALID:')) throw error;
      fail(`manifest case ${index + 1} repository could not be verified without network access.`);
    }
    repositoryRoots.set(root, repositoryRoots.get(root) ?? repositoryStateFingerprint(root));
    if (repositoryRoots.size > MAX_REPOSITORIES) {
      fail(`manifest exceeds the ${MAX_REPOSITORIES}-repository ceiling.`);
    }
    const workingDirectory = normalizeRelative(entry.workingDirectory, `manifest case ${index + 1} workingDirectory`);
    const report = normalizeRelative(entry.report, `manifest case ${index + 1} report`);
    const framework = FRAMEWORKS[entry.framework];
    let reportRoot;
    try {
      await secureRepositoryPath(root, workingDirectory, {
        label: 'WEL corpus working directory', mustExist: true, type: 'directory'
      });
      const securedReport = await secureRepositoryPath(root, report, {
        label: 'WEL corpus report', mustExist: true, type: framework.reportKind
      });
      reportRoot = securedReport.absolute;
    } catch {
      fail(`manifest case ${index + 1} paths could not be verified inside its repository.`);
    }
    const tuple = JSON.stringify([root, workingDirectory, report, entry.framework]);
    if (tuples.has(tuple)) fail(`manifest case ${index + 1} repeats an earlier source/report selection.`);
    tuples.add(tuple);
    cases.push({
      index, root, workingDirectory, report, reportRoot,
      framework, expected: structuredClone(entry.expected)
    });
  }
  return { cases, repositoryRoots };
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

function sortedCounts(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function repositoryRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

async function junitReportSelection(entry) {
  const queue = [{ absolute: entry.reportRoot, depth: 0 }];
  const files = [];
  while (queue.length) {
    const current = queue.shift();
    let children;
    try {
      children = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      fail(`manifest case ${entry.index + 1} report directory could not be read safely.`);
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (child.isSymbolicLink()) {
        fail(`manifest case ${entry.index + 1} report directory contains a symbolic link.`);
      }
      const absolute = path.join(current.absolute, child.name);
      const relative = repositoryRelative(entry.root, absolute);
      if (child.isDirectory()) {
        if (current.depth >= MAX_REPORT_DEPTH) {
          fail(`manifest case ${entry.index + 1} report directory exceeds the depth ceiling.`);
        }
        try {
          await secureRepositoryPath(entry.root, relative, {
            label: 'WEL corpus report directory', mustExist: true, type: 'directory'
          });
        } catch {
          fail(`manifest case ${entry.index + 1} report directory could not be verified safely.`);
        }
        queue.push({ absolute, depth: current.depth + 1 });
        continue;
      }
      if (!child.isFile() || !/\.xml$/iu.test(child.name)) continue;
      if (files.length >= MAX_REPORT_FILES) {
        fail(`manifest case ${entry.index + 1} report directory exceeds the file ceiling.`);
      }
      let secured;
      try {
        secured = await secureRepositoryPath(entry.root, relative, {
          label: 'WEL corpus report', mustExist: true, type: 'file'
        });
      } catch {
        fail(`manifest case ${entry.index + 1} report file could not be verified safely.`);
      }
      files.push({ absolute: secured.absolute, sourcePath: relative });
    }
  }
  const rawReports = [];
  let totalBytes = 0;
  for (const file of files) {
    const contents = await readBoundedRegularFile(
      file.absolute, MAX_REPORT_BYTES, `manifest case ${entry.index + 1} report`
    );
    totalBytes += contents.length;
    if (totalBytes > MAX_REPORT_TOTAL_BYTES) {
      fail(`manifest case ${entry.index + 1} reports exceed the total byte ceiling.`);
    }
    rawReports.push({ sourcePath: file.sourcePath, contents });
  }
  return { rawReports };
}

async function readReportSelection(entry) {
  if (entry.framework.reportKind === 'directory') return await junitReportSelection(entry);
  const contents = await readBoundedRegularFile(
    entry.reportRoot, MAX_REPORT_BYTES, `manifest case ${entry.index + 1} report`
  );
  return { rawReports: [{ sourcePath: entry.report, contents }] };
}

async function observeCase(entry, reportSelection) {
  const { framework } = entry;
  let replay;
  try {
    replay = framework.family === 'junit'
      ? replayLocalJunitObservation(reportSelection.rawReports)
      : replayLocalJavascriptJsonObservation(reportSelection.rawReports, framework.resultAdapter);
  } catch (error) {
    if (typeof error?.code === 'string') {
      return { outcome: 'report-refused', reason: error.code, observation: null };
    }
    throw error;
  }
  const command = {
    id: 'wel-real-corpus', kind: 'test', argv: framework.argv,
    workingDirectory: entry.workingDirectory, affectedRoots: [entry.workingDirectory],
    modelPolicy: 'never',
    result: { adapter: framework.resultAdapter, path: entry.report, minimumDiscovered: 1 }
  };
  const parsed = {
    adapter: framework.resultAdapter,
    tests: replay.tests,
    testcaseObservation: replay.testcaseObservation,
    result: {
      path: entry.report, sha256: replay.result.sha256, bytes: replay.result.bytes,
      files: replay.result.files.map((file, index) => ({
        sourcePath: reportSelection.rawReports[index].sourcePath, ...file
      }))
    },
    rawReports: reportSelection.rawReports.map((report, index) => ({
      sourcePath: report.sourcePath,
      sha256: replay.result.files[index].sha256,
      bytes: replay.result.files[index].bytes,
      contents: report.contents
    })),
    minimumDiscovered: 1,
    minimumPassed: 0
  };
  const policy = {
    mode: 'observe', adapter: framework.profile, requiredWitnessTypes: ['test'],
    evidenceTier: 'testcase-local-observed'
  };
  const observation = framework.family === 'junit'
    ? await observeJunit5SurefireIdentities(entry.root, command, parsed, policy)
    : await observeJavascriptTestIdentities(entry.root, command, parsed, policy);
  if (observation?.exact === true) return { outcome: 'exact', reason: null, observation };
  return {
    outcome: 'inexact',
    reason: observation?.gaps?.[0] ?? 'WITNESS_MAPPING_PROPOSALS_UNAVAILABLE',
    observation
  };
}

async function main() {
  const requested = parseArguments(process.argv);
  const manifestBytes = await readBoundedRegularFile(
    requested.manifest, MAX_MANIFEST_BYTES, 'corpus manifest'
  );
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { fail('corpus manifest is not canonical UTF-8 JSON.'); }
  const { cases, repositoryRoots } = await validateManifest(input);
  const timings = [];
  const cpuTimings = [];
  const catalogBytes = [];
  const counts = {
    expectedExact: 0, expectedInexact: 0, expectedReportRefused: 0,
    observedExact: 0, observedInexact: 0, observedReportRefused: 0,
    falseExact: 0, falseInconclusive: 0, mismatched: 0,
    mappingProposals: 0, exactOccurrences: 0, reasons: {}
  };
  for (const entry of cases) {
    const reportSelection = await readReportSelection(entry);
    let final;
    for (let sample = 0; sample < requested.samples; sample += 1) {
      const startedAt = performance.now();
      const cpuStarted = process.cpuUsage();
      try { final = await observeCase(entry, reportSelection); }
      catch { fail(`manifest case ${entry.index + 1} could not be measured safely.`); }
      timings.push(performance.now() - startedAt);
      const cpu = process.cpuUsage(cpuStarted);
      cpuTimings.push((cpu.user + cpu.system) / 1_000);
    }
    counts[`expected${entry.expected.outcome === 'report-refused' ? 'ReportRefused'
      : entry.expected.outcome[0].toUpperCase() + entry.expected.outcome.slice(1)}`] += 1;
    counts[`observed${final.outcome === 'report-refused' ? 'ReportRefused'
      : final.outcome[0].toUpperCase() + final.outcome.slice(1)}`] += 1;
    const reasonMatch = entry.expected.reason === final.reason
      || (entry.expected.outcome === 'inexact'
        && final.observation?.gaps?.includes(entry.expected.reason));
    const matches = entry.expected.outcome === final.outcome
      && (entry.expected.reason === null ? final.reason === null : reasonMatch);
    if (!matches) counts.mismatched += 1;
    if (entry.expected.outcome !== 'exact' && final.outcome === 'exact') counts.falseExact += 1;
    if (entry.expected.outcome === 'exact' && final.outcome !== 'exact') counts.falseInconclusive += 1;
    if (final.reason) counts.reasons[final.reason] = (counts.reasons[final.reason] ?? 0) + 1;
    counts.mappingProposals += final.observation?.mappingProposals?.length ?? 0;
    counts.exactOccurrences += final.observation?.occurrences?.length ?? 0;
    catalogBytes.push(final.observation?.catalog
      ? Buffer.byteLength(JSON.stringify(final.observation.catalog), 'utf8') : 0);
  }
  for (const [root, before] of repositoryRoots) {
    if (repositoryStateFingerprint(root) !== before) fail('a selected repository changed while it was measured.');
  }
  const selectedFamilies = new Set(cases.map((entry) => entry.framework.family));
  const report = {
    schema: 'sflow-wel-real-corpus/v2',
    assurance: 'content-free-local-measurement',
    authority: 'none',
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    corpusProfile: 'operator-reviewed-manifest-v1',
    inputBinding: 'operator-reviewed-out-of-band',
    repositoryCount: repositoryRoots.size,
    caseCount: cases.length,
    requestedSamplesPerCase: requested.samples,
    completedMeasurements: cases.length * requested.samples,
    outcome: counts.mismatched === 0 ? 'observed' : 'mismatch',
    timingsMilliseconds: {
      observation: distribution(timings),
      cpu: distribution(cpuTimings)
    },
    catalogBytesPerCase: distribution(catalogBytes),
    counts: { ...counts, reasons: sortedCounts(counts.reasons) },
    availability: {
      javascriptStaticObservation: selectedFamilies.has('javascript') ? 'used' : 'not-selected',
      junitSurefireStaticObservation: selectedFamilies.has('junit') ? 'used' : 'not-selected',
      model: 'not-invoked',
      astIntelligence: 'not-invoked',
      structuralExtraction: selectedFamilies.has('junit') ? 'local-jdk-parser' : 'not-invoked',
      network: 'not-invoked',
      testExecution: 'not-invoked',
      cache: 'not-used-observe-only'
    },
    repositoryState: 'unchanged-observed',
    lifecycleGate: false,
    authoritative: false,
    releaseEligible: false,
    contentExcluded: [
      'manifest-path', 'repository-path', 'file-path', 'test-name', 'clause-id',
      'content-digest', 'source-bytes', 'report-bytes', 'work-id', 'git-identity',
      'prompt', 'transcript'
    ]
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (counts.mismatched !== 0) process.exitCode = 1;
}

main().catch((error) => {
  const message = String(error?.message ?? 'measurement failed');
  process.stderr.write(`${message.startsWith('WEL_REAL_CORPUS_INVALID:')
    ? message : 'WEL_REAL_CORPUS_INVALID: corpus measurement failed safely.'}\n`);
  process.exitCode = 1;
});
