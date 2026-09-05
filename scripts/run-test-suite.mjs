import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { signalProcessTree } from '../src/util.mjs';
import {
  discoverTestSuite, parsePositiveInteger, parseShard, partitionTestFiles, TEST_SUITES, testRunId
} from './test-suite-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const suite = argv.find((argument) => !argument.startsWith('--')) ?? 'all';
if (!TEST_SUITES.includes(suite)) throw new Error(`Test suite must be one of: ${TEST_SUITES.join(', ')}.`);
const option = (name) => argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const shard = parseShard(option('shard') ?? process.env.SINGULARITY_FLOW_TEST_SHARD ?? '1/1');
const deadlineMs = parsePositiveInteger(
  option('deadline-ms') ?? process.env.SINGULARITY_FLOW_TEST_DEADLINE_MS ?? 30 * 60 * 1000,
  'Test shard deadline', { minimum: 1_000, maximum: 4 * 60 * 60 * 1000 }
);
const receiptOption = option('receipt') ?? process.env.SINGULARITY_FLOW_TEST_RECEIPT ?? null;
const plan = await discoverTestSuite(root, suite);
const selectedShard = partitionTestFiles(plan.files, shard.count)[shard.index - 1];
const selected = selectedShard.files.map((file) => file.relative);
if (!selected.length) throw new Error(`Test shard ${shard.index}/${shard.count} selected no ${suite} files.`);

if (argv.includes('--list')) {
  for (const file of selected) console.log(file);
  process.exit(0);
}

/**
 * The VS Code extension is TypeScript, and its tests import the sources directly under
 * `--experimental-strip-types` rather than a built bundle — so they test what ships. Type stripping
 * arrived in Node 22.6, while this package supports Node 20. Newer runtimes use native stripping;
 * Node 20 uses the repository's bounded TypeScript loader. A supported runtime therefore executes
 * the same selected files instead of silently reporting a smaller green suite.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
const canStripTypes = major > 22 || (major === 22 && minor >= 6);
const needsStripping = selectedShard.files.some((file) => file.needsTypeStripping);
const failOnSkippedFiles = process.env.SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES === '1';
const flags = !needsStripping ? [] : canStripTypes
  ? ['--experimental-strip-types', '--no-warnings=ExperimentalWarning']
  : ['--experimental-loader', path.join(root, 'scripts', 'typescript-test-loader.mjs')];
if (needsStripping && !canStripTypes) {
  console.warn(`Node ${process.versions.node} will execute TypeScript-dependent tests through the bounded repository loader.`);
}
const releaseReporterFlags = failOnSkippedFiles
  ? ['--test-reporter', path.join(root, 'scripts', 'release-test-reporter.mjs')]
  : [];

/**
 * Test files are processes, and many of those processes spawn several CLI, Git, model-provider, and
 * extension-host children of their own. Letting `node --test` use every logical CPU therefore
 * multiplies into far more runnable processes than the machine can service. Four files at once keeps
 * useful file-level parallelism without starving their children. The aggregate runner divides that
 * budget among concurrently running shards, and CI may choose another positive value explicitly.
 */
const configuredConcurrency = process.env.SINGULARITY_FLOW_TEST_CONCURRENCY;
const parsedConcurrency = configuredConcurrency == null
  ? Math.min(4, availableParallelism())
  : Number(configuredConcurrency);
if (!Number.isInteger(parsedConcurrency) || parsedConcurrency < 1) {
  throw new Error('SINGULARITY_FLOW_TEST_CONCURRENCY must be a positive integer.');
}
const concurrencyFlag = `--test-concurrency=${parsedConcurrency}`;

/** Run against a throwaway machine-state root, never the developer's own. */
const machineState = mkdtempSync(path.join(tmpdir(), 'sflow-test-machine-state-'));
const isolated = {
  ...process.env,
  SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineState, 'workspaces.json'),
  SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineState, 'active-workspace.json'),
  SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineState, 'leads.json'),
  SINGULARITY_FLOW_WMB_SHARED_CACHE: path.join(machineState, 'wmb-shared-cache')
};
delete isolated.FORCE_COLOR;
delete isolated.SINGULARITY_FLOW_COLOR;
// A contract test may invoke this runner from inside node:test. The new child owns an independent
// test plan and must not inherit Node's private marker or Node will silently skip every selected
// file as a recursive run.
delete isolated.NODE_TEST_CONTEXT;

const MAX_TEST_OUTPUT_BYTES = 128 * 1024 * 1024;
const TERMINATION_GRACE_MS = 5_000;

async function executeBounded(argumentsList) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: root, env: isolated, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let deadline = null;
    let force = null;
    let final = null;
    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (force) clearTimeout(force);
      resolve({ status: status ?? 1, signal, error, stdout, stderr, timedOut, overflow });
    };
    const terminate = async (reason) => {
      if (final) return;
      final = reason;
      timedOut = reason === 'deadline';
      overflow = reason === 'output-overflow';
      await signalProcessTree(child, 'SIGTERM', { timeoutMs: 1_000 });
      if (settled) return;
      force = setTimeout(async () => {
        await signalProcessTree(child, 'SIGKILL', { timeoutMs: 1_000 });
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(1, 'SIGKILL');
      }, TERMINATION_GRACE_MS);
    };
    const append = (channel, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (channel === 'stdout') process.stdout.write(text);
      else process.stderr.write(text);
      if (overflow) return;
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_TEST_OUTPUT_BYTES) {
        void terminate('output-overflow');
        return;
      }
      if (channel === 'stdout') stdout += text;
      else stderr += text;
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => finish(1, null, error));
    child.once('close', (status, signal) => finish(final ? 1 : status, signal));
    deadline = setTimeout(() => { void terminate('deadline'); }, deadlineMs);
  });
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function parseSummary(output) {
  const labels = { tests: 'tests', passed: 'pass', failed: 'fail', cancelled: 'cancelled', skipped: 'skipped', todo: 'todo' };
  const summary = {};
  for (const [field, label] of Object.entries(labels)) {
    const matches = [...String(output).matchAll(new RegExp(`(?:ℹ|#)\\s+${label}\\s+(\\d+)`, 'g'))];
    if (!matches.length) return null;
    summary[field] = Number(matches.at(-1)[1]);
  }
  return summary;
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const startedAt = new Date().toISOString();
const started = Date.now();
console.log(`SFlow test shard ${shard.index}/${shard.count}: ${selected.length} ${suite} file(s), deadline ${deadlineMs} ms.`);
let result;
try {
  result = await executeBounded([
    ...releaseReporterFlags, ...flags, concurrencyFlag, '--test', ...selected
  ]);
} finally {
  rmSync(machineState, { recursive: true, force: true });
}
const summary = parseSummary(`${result.stdout}\n${result.stderr}`);
const complete = summary != null;
const passed = result.status === 0 && complete
  && summary.failed === 0 && summary.cancelled === 0 && summary.todo === 0
  && (!failOnSkippedFiles || summary.skipped === 0);
const commit = git(['rev-parse', '--verify', 'HEAD']);
const tree = git(['rev-parse', '--verify', 'HEAD^{tree}']);
const cleanCheckout = (git(['status', '--porcelain=v1', '--untracked-files=all']) ?? '') === '';
const runIdentity = {
  suite, shardCount: shard.count, sourceSha256: plan.sourceSha256, commit, tree,
  platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node,
  failOnSkipped: failOnSkippedFiles
};
const receipt = {
  schemaVersion: 1, // schema-transient: local test-run receipt, never a durable product record
  runId: testRunId(runIdentity), suite, status: passed ? 'passed' : 'failed',
  startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started,
  shardIndex: shard.index, shardCount: shard.count, selectedFiles: selected.length,
  sourceSha256: selectedShard.sourceSha256, commit, tree, cleanCheckout,
  platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node,
  failOnSkipped: failOnSkippedFiles, deadlineMs, timedOut: result.timedOut,
  outputOverflow: result.overflow, exitCode: result.status, signal: result.signal ?? null,
  summary: summary ?? { tests: 0, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 }
};
if (receiptOption) await writeAtomic(path.resolve(root, receiptOption), receipt);

if (result.timedOut) {
  console.error(`\nSFlow test shard ${shard.index}/${shard.count} exceeded its ${deadlineMs} ms deadline.`);
  console.error(`Retry exactly: node scripts/run-test-suite.mjs ${suite} --shard=${shard.index}/${shard.count} --deadline-ms=${deadlineMs}`);
} else if (result.overflow) {
  console.error(`\nSFlow test shard ${shard.index}/${shard.count} exceeded its bounded output allowance.`);
} else if (!complete) {
  console.error(`\nSFlow test shard ${shard.index}/${shard.count} produced no complete Node test summary.`);
}
process.exitCode = passed ? 0 : 1;
