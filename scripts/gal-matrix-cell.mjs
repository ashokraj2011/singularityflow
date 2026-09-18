#!/usr/bin/env node
/**
 * Run one bounded, source-bound GAL qualification cell. This collects local evidence only: a
 * successful cell is not a signed multi-host release approval or an office-network witness.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGitRuntime } from '../src/git-access.mjs';
import { withoutGitProcessOverrides } from '../src/git-enterprise-environment.mjs';
import { signalProcessTree } from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = Object.freeze([
  'test/git-access.test.mjs',
  'test/git-access-blob-check.test.mjs',
  'test/git-access-remote-ref.test.mjs',
  'test/git-access-typed-reads.test.mjs',
  'test/git-access-status.test.mjs',
  'test/git-local-blob-async.test.mjs',
  'test/git-status-detail.test.mjs',
  'test/fos-object-service.test.mjs',
  'test/gal-object-transport-conformance.test.mjs',
  'test/fos-git-query.test.mjs',
  'test/git-execution.test.mjs',
  'test/git-isolation-paths.test.mjs',
  'test/platform-process.test.mjs',
  'test/git-bypass-audit.test.mjs',
  'test/gal-read-benchmark.test.mjs'
]);
const OUTPUT_LIMIT = 8 * 1024 * 1024;
// These fixtures currently require POSIX shell wrappers or filename behavior. They are explicit
// Windows coverage gaps, not passing acceptance evidence. A new skip is a test failure.
const WINDOWS_EXCLUSIONS = new Set([
  'GAL status/index reads preserve unsafe names and bind exact subjects to the verified repository',
  'GAL typed reads refuse malformed framing without treating it as empty',
  'GAL blob subprocess I/O does not block the event loop',
  'GAL disposal cancels an in-flight blob read',
  'GAL blob deadline stops a slow content stage',
  'GAL rejects a well-framed blob with bytes that do not hash to its OID',
  'GAL refuses a torn HEAD observation when checkout changes between its reads',
  'GAL does not release an in-flight captured result after repository replacement',
  'GAL:AC-020 promised blob stays local-only until a separate acquisition'
]);

export function runtimeClass(version) {
  const major = Number(String(version).split('.')[0]);
  if ([22, 24].includes(major)) return 'primary';
  if (major === 20) return 'legacy-compatibility';
  return 'development-only';
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function summarizeTap(stdout) {
  const values = {};
  for (const [, key, value] of stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)\s*$/gmu)) {
    values[key] = Number(value);
  }
  return ['tests', 'pass', 'fail', 'cancelled', 'skipped'].every((key) =>
    Number.isSafeInteger(values[key])) ? values : null;
}

function skippedTapTests(stdout) {
  return [...stdout.matchAll(/^ok \d+ - (.+?) # SKIP(?: .*)?$/gmu)]
    .map((match) => match[1]);
}

export function classifySkippedScenarios(stdout, platform = process.platform) {
  const skippedScenarios = skippedTapTests(stdout);
  const allowedExclusions = platform === 'win32' ? WINDOWS_EXCLUSIONS : new Set();
  return {
    skippedScenarios,
    unexpectedSkips: skippedScenarios.filter((name) => !allowedExclusions.has(name))
  };
}

async function runBounded(executable, args, {
  timeoutMs, maxOutput = OUTPUT_LIMIT, env = process.env
} = {}) {
  const child = spawn(executable, args, {
    cwd: ROOT, env, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  let bytes = 0;
  let boundary = null;
  let errorCode = null;
  let settled = false;
  let cleanupPromise = null;
  let settlementTimer;
  let timeoutTimer;
  const began = Date.now();
  return new Promise((resolve) => {
    const finish = (code, signal, processClosed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(settlementTimer);
      resolve({
        status: boundary ? null : code,
        signal: signal ?? null,
        timedOut: boundary === 'timeout',
        outputOverflow: boundary === 'overflow',
        cleanupSignalAccepted: boundary ? cleanupPromise !== null && cleanupDone : null,
        processClosed,
        spawnErrorCode: errorCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        outputSha256: digest(Buffer.concat([...stdoutChunks, ...stderrChunks])),
        durationMs: Date.now() - began
      });
    };
    let cleanupDone = false;
    const terminate = (reason) => {
      if (settled || boundary) return;
      boundary = reason;
      // The child is an owned, detached process group on POSIX. The shared supervisor uses
      // taskkill /T on Windows; never kill unrelated Git processes by executable name.
      cleanupPromise = Promise.resolve(signalProcessTree(child, 'SIGKILL', { timeoutMs: 1_000 }))
        .then((accepted) => { cleanupDone = accepted === true; }, () => { cleanupDone = false; });
      settlementTimer = setTimeout(() => finish(null, 'SIGKILL', false), 2_000);
    };
    const capture = (target, chunk) => {
      if (settled || boundary) return;
      bytes += chunk.length;
      if (bytes > maxOutput) { terminate('overflow'); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk) => capture(stdoutChunks, chunk));
    child.stderr.on('data', (chunk) => capture(stderrChunks, chunk));
    child.on('error', (error) => {
      errorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      if (!child.pid) finish(null, null, true);
      else terminate('spawn-error');
    });
    child.on('close', async (code, signal) => {
      if (cleanupPromise) await cleanupPromise;
      finish(code, signal, true);
    });
    timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);
  });
}

async function cell() {
  const preflightOnly = process.argv.includes('--preflight-only');
  if (process.argv.slice(2).some((arg) => arg !== '--preflight-only')) {
    throw Object.assign(new Error('Unsupported GAL matrix option.'), { code: 'GAL_MATRIX_OPTION_INVALID' });
  }
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const runtime = await createGitRuntime();
  if (!runtime.ok) {
    throw Object.assign(new Error('Git preflight failed.'), { code: 'GAL_MATRIX_GIT_UNAVAILABLE' });
  }
  const gitText = runtime.value.identity.version;
  const gitEnvironment = withoutGitProcessOverrides(process.env);
  const revision = await runBounded(runtime.value.identity.path, ['rev-parse', 'HEAD'], {
    timeoutMs: 10_000, maxOutput: 4_096, env: gitEnvironment
  });
  const workingTree = await runBounded(runtime.value.identity.path,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      timeoutMs: 10_000, maxOutput: 1024 * 1024, env: gitEnvironment
    });
  await runtime.value.dispose();
  if (revision.status !== 0 || revision.timedOut || workingTree.status !== 0
      || workingTree.timedOut || workingTree.outputOverflow) {
    throw Object.assign(new Error('Git preflight failed.'), { code: 'GAL_MATRIX_GIT_UNAVAILABLE' });
  }
  const sourceRevision = revision.stdout.trim();
  const sourceDirty = workingTree.stdout.length > 0;
  if (!/^git version [^\r\n]+$/u.test(gitText) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(sourceRevision)) {
    throw Object.assign(new Error('Git preflight protocol invalid.'), { code: 'GAL_MATRIX_GIT_PROTOCOL_INVALID' });
  }
  const report = {
    schema: 'sflow-gal-matrix-cell/v1',
    sourceRevision, sourceDirty, packageVersion: packageJson.version,
    platform: process.platform, architecture: process.arch, osRelease: os.release(),
    nodeVersion: process.versions.node, runtimeClass: runtimeClass(process.versions.node),
    gitVersion: gitText,
    testFiles: [...TESTS],
    localEvidenceOnly: true, releaseQualified: false,
    requiredExternalEvidence: [
      'independent Windows, macOS, and Linux cells on approved Node 22 and 24 patches',
      'retained Node 20 compatibility cells until package policy changes',
      'physical office credential, proxy, filesystem, worktree, cleanup, and package/VSIX receipts',
      'independent review and signed artifact/source binding'
    ]
  };
  if (preflightOnly) return { ...report, status: 'preflight' };
  const tests = await runBounded(process.execPath, [
    '--test', '--test-concurrency=2', '--test-reporter=tap', ...TESTS
  ], { timeoutMs: 10 * 60_000 });
  const summary = summarizeTap(tests.stdout);
  const { skippedScenarios, unexpectedSkips } = classifySkippedScenarios(tests.stdout);
  const testResult = {
    status: tests.status, signal: tests.signal, timedOut: tests.timedOut,
    outputOverflow: tests.outputOverflow, cleanupSignalAccepted: tests.cleanupSignalAccepted,
    processClosed: tests.processClosed,
    spawnErrorCode: tests.spawnErrorCode, durationMs: tests.durationMs,
    outputSha256: tests.outputSha256, summary, skippedScenarios, unexpectedSkips
  };
  if (tests.status !== 0 || !summary || summary.fail !== 0 || summary.cancelled !== 0
      || summary.skipped !== skippedScenarios.length || unexpectedSkips.length
      || summary.pass + summary.skipped !== summary.tests) {
    return { ...report, status: 'failed', tests: testResult, benchmark: null };
  }
  const benchmark = await runBounded(process.execPath, [
    'scripts/gal-read-benchmark.mjs', '--samples=10', '--objects=500'
  ], { timeoutMs: 2 * 60_000, maxOutput: 1024 * 1024 });
  let measurement = null;
  if (benchmark.status === 0 && !benchmark.outputOverflow && !benchmark.timedOut) {
    try { measurement = JSON.parse(benchmark.stdout); } catch { /* protocol failure */ }
  }
  const validMeasurement = measurement?.schema === 'sflow-gal-read-benchmark/v1'
    && measurement?.sourceRevision === sourceRevision
    && measurement?.parity?.referenceExactBytes === true
    && measurement?.parity?.asyncReferenceExactBytes === true
    && measurement?.parity?.persistentExactBytes === true
    && measurement?.declaredFixtureComplete === true;
  return {
    ...report, status: !validMeasurement ? 'failed'
      : sourceDirty ? 'unqualified-dirty'
        : skippedScenarios.length ? 'local-incomplete' : 'local-pass', tests: testResult,
    benchmark: {
      status: benchmark.status, signal: benchmark.signal, timedOut: benchmark.timedOut,
      outputOverflow: benchmark.outputOverflow,
      cleanupSignalAccepted: benchmark.cleanupSignalAccepted,
      processClosed: benchmark.processClosed,
      spawnErrorCode: benchmark.spawnErrorCode, durationMs: benchmark.durationMs,
      outputSha256: benchmark.outputSha256,
      ...(validMeasurement ? { measurement } : {})
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cell().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!['preflight', 'local-pass'].includes(result.status)) process.exitCode = 1;
  }, (error) => {
    process.stderr.write(`${JSON.stringify({ schema: 'sflow-gal-matrix-cell/v1', status: 'failed',
      code: typeof error?.code === 'string' ? error.code : 'GAL_MATRIX_FAILED' })}\n`);
    process.exitCode = 1;
  });
}
