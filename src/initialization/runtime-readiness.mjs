import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat, mkdir, readFile, readlink, rename, rm, writeFile
} from 'node:fs/promises';
import path from 'node:path';

import { inferRepositoryTestCommands } from '../delivery-evidence.mjs';
import { gitCommonDir, head } from '../git.mjs';
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { signalProcessTree, SingularityFlowError, run } from '../util.mjs';
import { runSmartInitDetectors } from './detectors.mjs';
import { captureSmartInitSnapshot } from './source-snapshot.mjs';

const PURPOSE_ORDER = Object.freeze(['dependency', 'build', 'quality', 'test', 'start']);
const PURPOSE_RANK = new Map(PURPOSE_ORDER.map((purpose, index) => [purpose, index]));
const READINESS_SCOPES = Object.freeze(['full', 'dependency-test']);
const READINESS_SCOPE_SET = new Set(READINESS_SCOPES);
const DEFAULT_TIMEOUTS_MS = Object.freeze({
  dependency: 10 * 60_000,
  build: 10 * 60_000,
  quality: 5 * 60_000,
  test: 10 * 60_000,
  start: 30_000
});
const DEFAULT_START_SURVIVAL_MS = 5_000;
const MAX_COMMANDS = 200;
const MAX_ARGV_BYTES = 24 * 1024;
const MAX_UNTRACKED_FILES = 10_000;
const MAX_UNTRACKED_BYTES = 128 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30 * 60_000;
const RECEIPT_FAMILY = 'repository-readiness-receipt';
const RECEIPT_SCHEMA_VERSION = currentSchemaVersion(RECEIPT_FAMILY);
const RESULT_REASONS = new Set([
  'aborted', 'launch-survived', 'non-zero-exit', 'process-tree-not-quiescent',
  'start-exited-before-survival', 'timeout'
]);

function readinessScope(value = 'full') {
  const scope = String(value ?? 'full');
  if (!READINESS_SCOPE_SET.has(scope)) throw new SingularityFlowError(
    `Unknown repository readiness scope '${scope}'.`,
    { code: 'REPOSITORY_READINESS_SCOPE_INVALID', details: { scope, supported: READINESS_SCOPES } }
  );
  return scope;
}

function recordedReceiptScope(receipt) {
  // Receipts written before scopes were introduced are full readiness receipts.
  return readinessScope(receipt?.scope ?? 'full');
}

function scopeAllowsReceipt(requestedScope, receiptScope) {
  return requestedScope === receiptScope
    || (requestedScope === 'dependency-test' && receiptScope === 'full');
}

function digest(value) {
  return `sha256:${recordSha256(value)}`;
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function nullList(value) {
  return String(value ?? '').split('\0').filter(Boolean).sort((left, right) => left.localeCompare(right, 'en'));
}

function gitOutput(root, args, code, message) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(message, { code });
  return result.stdout;
}

function trackedChanges(root) {
  return [...new Set([
    ...nullList(gitOutput(root, ['diff', '--name-only', '-z', 'HEAD', '--'],
      'REPOSITORY_READINESS_GIT_FAILED', 'Repository readiness could not inspect tracked changes.')),
    ...nullList(gitOutput(root, ['diff', '--name-only', '-z', '--cached', 'HEAD', '--'],
      'REPOSITORY_READINESS_GIT_FAILED', 'Repository readiness could not inspect staged changes.'))
  ])].sort((left, right) => left.localeCompare(right, 'en'));
}

function assertCleanTrackedTree(root) {
  const changed = trackedChanges(root);
  if (changed.length) {
    throw new SingularityFlowError(
      `Repository readiness requires a clean tracked tree; ${changed.length} tracked path(s) are changed: ${changed.slice(0, 20).join(', ')}.`,
      { code: 'REPOSITORY_READINESS_TRACKED_DIRTY', details: { changedPaths: changed } }
    );
  }
}

async function fileDigest(file) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

async function untrackedFingerprint(root) {
  const files = nullList(gitOutput(root, ['ls-files', '--others', '--exclude-standard', '-z'],
    'REPOSITORY_READINESS_GIT_FAILED', 'Repository readiness could not inspect untracked paths.'));
  if (files.length > MAX_UNTRACKED_FILES) {
    throw new SingularityFlowError(
      `Repository readiness found ${files.length} untracked files; the bound is ${MAX_UNTRACKED_FILES}.`,
      { code: 'REPOSITORY_READINESS_SCAN_BOUND', details: { observed: files.length, bound: MAX_UNTRACKED_FILES } }
    );
  }
  let bytes = 0;
  const entries = [];
  for (const relative of files) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      entries.push({ path: relative, kind: 'symlink', targetSha256: sha256Bytes(await readlink(absolute)) });
      continue;
    }
    if (!info.isFile()) {
      entries.push({ path: relative, kind: 'other' });
      continue;
    }
    bytes += info.size;
    if (bytes > MAX_UNTRACKED_BYTES) {
      throw new SingularityFlowError(
        `Repository readiness untracked bytes exceed ${MAX_UNTRACKED_BYTES}.`,
        { code: 'REPOSITORY_READINESS_SCAN_BOUND', details: { observed: bytes, bound: MAX_UNTRACKED_BYTES } }
      );
    }
    entries.push({ path: relative, kind: 'file', bytes: info.size, sha256: await fileDigest(absolute) });
  }
  return { count: entries.length, bytes, digest: digest(entries) };
}

async function captureWorkingTreeBaseline(root) {
  assertCleanTrackedTree(root);
  return {
    commit: head(root),
    untracked: await untrackedFingerprint(root)
  };
}

async function assertWorkingTreeUnchanged(root, baseline) {
  const currentCommit = head(root);
  const changed = trackedChanges(root);
  const untracked = await untrackedFingerprint(root);
  if (currentCommit !== baseline.commit || changed.length || untracked.digest !== baseline.untracked.digest) {
    throw new SingularityFlowError(
      'Repository readiness command changed repository source bytes; no passing receipt was written.',
      {
        code: 'REPOSITORY_READINESS_SOURCE_DRIFT',
        details: {
          expectedCommit: baseline.commit,
          actualCommit: currentCommit,
          changedPaths: changed,
          untrackedChanged: untracked.digest !== baseline.untracked.digest
        }
      }
    );
  }
}

function positiveBoundedInteger(value, fallback, maximum = MAX_TIMEOUT_MS) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

function safeRelativeDirectory(value) {
  const normalized = String(value ?? '.').replaceAll('\\', '/').replace(/^\.\//u, '') || '.';
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)
      || /^[a-z]:\//iu.test(normalized)
      || normalized.includes('\0')) {
    throw new SingularityFlowError(`Repository readiness working directory escapes the repository: ${value}`, {
      code: 'REPOSITORY_READINESS_COMMAND_INVALID'
    });
  }
  return path.posix.normalize(normalized);
}

function safeArgv(argv) {
  const bytes = Array.isArray(argv)
    ? argv.reduce((total, argument) => total + Buffer.byteLength(String(argument)) + 1, 0)
    : Infinity;
  if (!Array.isArray(argv) || !argv.length || argv.length > 200
      || bytes > MAX_ARGV_BYTES
      || argv.some((argument) => typeof argument !== 'string' || !argument || argument.includes('\0')
        || Buffer.byteLength(argument) > 16 * 1024)) {
    throw new SingularityFlowError('Repository readiness commands require bounded, non-empty argv.', {
      code: 'REPOSITORY_READINESS_COMMAND_INVALID'
    });
  }
  return [...argv];
}

function safeId(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'root';
}

function normalizedCommand(command, purpose, source, options = {}) {
  const argv = command.argv
    ? safeArgv(command.argv)
    : safeArgv([resolveDetectorLauncher(command.launcher, options.platform), ...(command.args ?? [])]);
  const workingDirectory = safeRelativeDirectory(command.workingDirectory);
  const timeoutMs = positiveBoundedInteger(
    options.timeouts?.[purpose],
    DEFAULT_TIMEOUTS_MS[purpose]
  );
  const normalized = {
    id: String(command.id ?? `${purpose}-${safeId(workingDirectory)}`),
    purpose,
    argv,
    workingDirectory,
    mode: purpose === 'start' ? 'launch-survival' : 'completion',
    timeoutMs,
    source
  };
  if (purpose === 'start') normalized.survivalMs = Math.min(
    positiveBoundedInteger(options.startSurvivalMs, DEFAULT_START_SURVIVAL_MS, timeoutMs - 1),
    Math.max(1, timeoutMs - 1)
  );
  return normalized;
}

function resolveDetectorLauncher(launcher, platform) {
  if (launcher === 'maven-wrapper') return platform === 'win32' ? '.\\mvnw.cmd' : './mvnw';
  if (launcher === 'gradle-wrapper') return platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  return launcher;
}

function manifestMap(snapshot) {
  return new Map(snapshot.entries
    .filter((entry) => entry.kind === 'manifest' || entry.kind === 'binary-manifest')
    .map((entry) => [entry.path, entry]));
}

function atDirectory(files, directory, name) {
  return files.get(directory === '.' ? name : `${directory}/${name}`) ?? null;
}

function nodeManager(manifest, files, directory) {
  const declared = String(manifest.packageManager ?? '').split('@')[0].toLowerCase();
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  if (atDirectory(files, directory, 'pnpm-lock.yaml')) return 'pnpm';
  if (atDirectory(files, directory, 'yarn.lock')) return 'yarn';
  if (atDirectory(files, directory, 'bun.lock') || atDirectory(files, directory, 'bun.lockb')) return 'bun';
  if (atDirectory(files, directory, 'package-lock.json') || atDirectory(files, directory, 'npm-shrinkwrap.json')) return 'npm';
  return null;
}

function nodeRunArgv(manager, script) {
  return manager === 'npm' ? ['npm', 'run', script]
    : manager === 'pnpm' ? ['pnpm', 'run', script]
      : manager === 'yarn' ? ['yarn', 'run', script] : ['bun', 'run', script];
}

function manifestCommands(snapshot, options) {
  const files = manifestMap(snapshot);
  const commands = [];
  for (const source of files.values()) {
    if (path.posix.basename(source.path) !== 'package.json' || typeof source.content !== 'string') continue;
    let manifest;
    try { manifest = JSON.parse(source.content); }
    catch { continue; }
    const directory = path.posix.dirname(source.path) === '.' ? '.' : path.posix.dirname(source.path);
    const manager = nodeManager(manifest, files, directory);
    if (!manager) continue;
    const hasLock = manager === 'npm'
      ? Boolean(atDirectory(files, directory, 'package-lock.json') || atDirectory(files, directory, 'npm-shrinkwrap.json'))
      : manager === 'pnpm' ? Boolean(atDirectory(files, directory, 'pnpm-lock.yaml'))
        : manager === 'yarn' ? Boolean(atDirectory(files, directory, 'yarn.lock'))
          : Boolean(atDirectory(files, directory, 'bun.lock') || atDirectory(files, directory, 'bun.lockb'));
    if (hasLock) {
      let argv;
      if (manager === 'npm') argv = ['npm', 'ci'];
      else if (manager === 'pnpm') argv = ['pnpm', 'install', '--frozen-lockfile'];
      else if (manager === 'bun') argv = ['bun', 'install', '--frozen-lockfile'];
      else {
        const major = Number(/^yarn@(\d+)/iu.exec(String(manifest.packageManager ?? ''))?.[1]);
        argv = ['yarn', 'install', Number.isFinite(major) && major >= 2 ? '--immutable' : '--frozen-lockfile'];
      }
      commands.push(normalizedCommand({
        id: `dependency-node-${safeId(directory)}`, argv, workingDirectory: directory
      }, 'dependency', 'manifest', options));
    }
    if (typeof manifest.scripts?.start === 'string' && manifest.scripts.start.trim()) {
      commands.push(normalizedCommand({
        id: `start-node-${safeId(directory)}`, argv: nodeRunArgv(manager, 'start'), workingDirectory: directory
      }, 'start', 'manifest', options));
    }
  }
  for (const source of files.values()) {
    const name = path.posix.basename(source.path).toLowerCase();
    const directory = path.posix.dirname(source.path) === '.' ? '.' : path.posix.dirname(source.path);
    if (name === 'go.mod') commands.push(normalizedCommand({
      id: `dependency-go-${safeId(directory)}`, argv: ['go', 'mod', 'download'], workingDirectory: directory
    }, 'dependency', 'manifest', options));
    if (name === 'cargo.lock') commands.push(normalizedCommand({
      id: `dependency-rust-${safeId(directory)}`, argv: ['cargo', 'fetch', '--locked'], workingDirectory: directory
    }, 'dependency', 'manifest', options));
  }
  return commands;
}

function deduplicateCommands(commands) {
  const seen = new Set();
  return commands.filter((command) => {
    const key = JSON.stringify([command.purpose, command.argv, command.workingDirectory]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (PURPOSE_RANK.get(left.purpose) - PURPOSE_RANK.get(right.purpose))
    || left.workingDirectory.localeCompare(right.workingDirectory, 'en')
    || left.id.localeCompare(right.id, 'en'));
}

function publicStructuredTest(command) {
  return {
    id: command.id,
    workingDirectory: safeRelativeDirectory(command.workingDirectory),
    affectedRoots: [...(command.affectedRoots ?? [])].map(safeRelativeDirectory).sort(),
    adapter: command.result?.adapter ?? null
  };
}

/**
 * Build the immutable command plan used by the pre-Story repository readiness gate.
 * Nothing is executed and no model is involved.
 */
export async function buildRepositoryReadinessPlan(root, options = {}) {
  const scope = readinessScope(options.scope);
  assertCleanTrackedTree(root);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const snapshot = options.snapshot ?? await captureSmartInitSnapshot(root);
  const detectorOutput = options.detectorOutput ?? runSmartInitDetectors(snapshot);
  let inferredTests = [];
  let testInferenceError = null;
  try {
    inferredTests = await (options.inferTestCommands ?? inferRepositoryTestCommands)(root, {
      unitOnly: scope === 'dependency-test'
    });
  } catch (error) {
    testInferenceError = { code: error?.code ?? 'TEST_INFERENCE_FAILED' };
  }
  const detectorCommands = [
    ...(detectorOutput.commands?.dependency ?? []).map((command) => normalizedCommand(command, 'dependency', 'smart-init-detector', { ...options, platform })),
    ...(scope === 'full' ? (detectorOutput.commands?.build ?? []).map((command) => normalizedCommand(
      command, 'build', 'smart-init-detector', { ...options, platform }
    )) : []),
    ...(scope === 'full' ? (detectorOutput.commands?.quality ?? []).map((command) => normalizedCommand(
      command, 'quality', 'smart-init-detector', { ...options, platform }
    )) : []),
    ...(scope === 'full' ? (detectorOutput.commands?.start ?? []).map((command) => normalizedCommand(
      command, 'start', 'smart-init-detector', { ...options, platform }
    )) : [])
  ];
  const testCommands = [
    ...inferredTests.map((command) => normalizedCommand(
      command, 'test', 'structured-test-inference', { ...options, platform }
    )),
    ...(scope === 'full' ? (detectorOutput.commands?.verification ?? []).map((command) => normalizedCommand(
      command, 'test', 'smart-init-detector', { ...options, platform }
    )) : [])
  ];
  const detectedScopes = new Set(detectorCommands.map((command) =>
    `${command.purpose}\0${command.workingDirectory}`));
  const manifestFallbackCommands = manifestCommands(snapshot, { ...options, platform })
    .filter((command) => !detectedScopes.has(`${command.purpose}\0${command.workingDirectory}`))
    .filter((command) => scope === 'full' || command.purpose === 'dependency');
  const commands = deduplicateCommands([
    ...detectorCommands,
    ...manifestFallbackCommands,
    ...testCommands
  ]);
  if (commands.length > MAX_COMMANDS) throw new SingularityFlowError(
    `Repository readiness selected ${commands.length} commands; the bound is ${MAX_COMMANDS}.`,
    { code: 'REPOSITORY_READINESS_COMMAND_BOUND', details: { observed: commands.length, bound: MAX_COMMANDS } }
  );
  const requireStructuredTest = options.requireStructuredTest ?? (detectorOutput.stacks ?? [])
    .some((stack) => stack !== 'container');
  const structuredTestContract = {
    status: inferredTests.length ? 'available' : testInferenceError ? 'unavailable' : 'missing',
    requiredForCode: Boolean(requireStructuredTest),
    satisfied: !requireStructuredTest || inferredTests.length > 0,
    commands: inferredTests.map(publicStructuredTest),
    error: testInferenceError
  };
  const ambiguities = structuredClone(detectorOutput.ambiguities ?? [])
    .filter((ambiguity) => scope === 'full'
      || !['build', 'quality', 'start'].includes(ambiguity.purpose))
    .sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? ''), 'en'));
  const blockers = [
    ...ambiguities.map((ambiguity) => ({
      code: 'REPOSITORY_READINESS_DETECTION_AMBIGUOUS',
      subject: ambiguity.id ?? 'detector-ambiguity'
    })),
    ...(!structuredTestContract.satisfied ? [{
      code: 'REPOSITORY_READINESS_STRUCTURED_TEST_REQUIRED',
      subject: 'repository-test-contract'
    }] : [])
  ];
  const executionPolicy = {
    timeoutsMs: Object.fromEntries(PURPOSE_ORDER.map((purpose) => [
      purpose,
      positiveBoundedInteger(options.timeouts?.[purpose], DEFAULT_TIMEOUTS_MS[purpose])
    ])),
    startSurvivalMs: commands.find((command) => command.purpose === 'start')?.survivalMs
      ?? positiveBoundedInteger(options.startSurvivalMs, DEFAULT_START_SURVIVAL_MS)
  };
  const core = {
    schemaVersion: 1,
    kind: 'repository-readiness-plan',
    scope,
    sourceCommit: snapshot.subject.baseCommit,
    sourceManifestSha256: snapshot.sourceManifestSha256,
    repositoryFingerprint: snapshot.subject.repositoryFingerprint,
    platform,
    arch,
    commands,
    executionPolicy,
    structuredTestContract,
    ambiguities,
    blockers,
    status: blockers.length ? 'blocked' : 'ready'
  };
  return Object.freeze({ ...core, planId: digest(core) });
}

function appendDigest(state, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.hash.update(bytes);
  state.bytes += bytes.length;
}

function sanitizedCommandResult(command, result, purpose = command.purpose) {
  const boundedNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, Number.MAX_SAFE_INTEGER) : 0;
  };
  const hash = (value) => /^sha256:[0-9a-f]{64}$/u.test(String(value ?? '')) ? value : null;
  const childSignal = /^SIG[A-Z0-9]{1,12}$/u.test(String(result?.signal ?? ''))
    ? result.signal : null;
  const reason = RESULT_REASONS.has(result?.reason) ? result.reason : null;
  return {
    id: command.id,
    purpose,
    status: result?.status === 'pass' ? 'pass' : 'failed',
    exitCode: Number.isInteger(result?.exitCode) && result.exitCode >= 0 && result.exitCode <= 255
      ? result.exitCode : null,
    signal: childSignal,
    reason,
    durationMs: boundedNumber(result?.durationMs),
    stdoutBytes: boundedNumber(result?.stdoutBytes),
    stderrBytes: boundedNumber(result?.stderrBytes),
    stdoutSha256: hash(result?.stdoutSha256),
    stderrSha256: hash(result?.stderrSha256)
  };
}

async function defaultRunCommand(command, {
  root,
  signal,
  environment = process.env,
  platform = process.platform,
  terminateTree = signalProcessTree,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now
} = {}) {
  const started = now();
  const stdout = { hash: createHash('sha256'), bytes: 0 };
  const stderr = { hash: createHash('sha256'), bytes: 0 };
  const cwd = path.resolve(root, command.workingDirectory);
  const relative = path.relative(root, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SingularityFlowError('Repository readiness command cwd escapes the repository.', {
      code: 'REPOSITORY_READINESS_COMMAND_INVALID'
    });
  }
  return await new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let survived = false;
    let survivalTimer = null;
    let forceTimer = null;
    const cleanup = () => {
      if (survivalTimer) clearTimeoutFn(survivalTimer);
      if (forceTimer) clearTimeoutFn(forceTimer);
      signal?.removeEventListener?.('abort', abort);
    };
    const streamDigest = (state) => {
      if (!state.digest) state.digest = `sha256:${state.hash.digest('hex')}`;
      return state.digest;
    };
    const summary = (status, extra = {}) => ({
      status,
      exitCode: extra.exitCode ?? null,
      signal: extra.signal ?? null,
      reason: extra.reason ?? null,
      durationMs: Math.max(0, now() - started),
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutSha256: streamDigest(stdout),
      stderrSha256: streamDigest(stderr)
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const terminate = async (terminationSignal) => {
      await terminateTree(child, terminationSignal, { platform, environment }).catch(() => false);
    };
    const forceSettlement = (result) => {
      // Delay output finalization until the fallback actually fires. A descendant can still emit
      // a final bounded chunk between the first signal and close; digesting eagerly would finalize
      // the hash and turn that harmless final chunk into ERR_CRYPTO_HASH_FINALIZED.
      forceTimer = setTimeoutFn(() => finish(result()), 2_000);
    };
    const abort = () => {
      const timedOut = signal?.reason === 'timeout';
      void terminate('SIGTERM').finally(() => {
        void terminate('SIGKILL');
        forceSettlement(() => summary('failed', { reason: timedOut ? 'timeout' : 'aborted' }));
      });
    };
    try {
      child = spawn(command.argv[0], command.argv.slice(1), {
        cwd,
        env: { ...environment, CI: '1', GIT_TERMINAL_PROMPT: '0' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32'
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.stdout?.on('data', (chunk) => appendDigest(stdout, chunk));
    child.stderr?.on('data', (chunk) => appendDigest(stderr, chunk));
    child.once('error', (error) => {
      if (settled) return;
      cleanup();
      reject(error);
    });
    child.once('close', (code, childSignal) => {
      if (settled) return;
      if (command.mode === 'launch-survival') {
        finish(survived
          ? summary('pass', { exitCode: code, signal: childSignal, reason: 'launch-survived' })
          : summary('failed', { exitCode: code, signal: childSignal, reason: 'start-exited-before-survival' }));
      } else {
        finish(summary(code === 0 ? 'pass' : 'failed', {
          exitCode: code, signal: childSignal, reason: code === 0 ? null : 'non-zero-exit'
        }));
      }
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    if (command.mode === 'launch-survival') {
      survivalTimer = setTimeoutFn(() => {
        survived = true;
        void terminate('SIGTERM').finally(() => {
          void terminate('SIGKILL');
          // A launch is ready only after the smoke process and every descendant quiesce. If the
          // close event never arrives, retained stdio or a surviving child is a failed readiness
          // check rather than a successful process that happens to be left on the laptop.
          forceSettlement(() => summary('failed', { reason: 'process-tree-not-quiescent' }));
        });
      }, command.survivalMs);
    }
  });
}

function receiptDirectory(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'repository-readiness');
}

function receiptFile(root, commit, platform = process.platform, arch = process.arch, scope = 'full') {
  if (!/^[0-9a-f]{40,64}$/iu.test(String(commit ?? ''))) {
    throw new SingularityFlowError('Repository readiness receipt requires an exact commit.', {
      code: 'REPOSITORY_READINESS_COMMIT_INVALID'
    });
  }
  const normalizedScope = readinessScope(scope);
  const suffix = normalizedScope === 'full' ? '' : `-${safeId(normalizedScope)}`;
  return path.join(receiptDirectory(root), `${String(commit).toLowerCase()}-${safeId(platform)}-${safeId(arch)}${suffix}.json`);
}

async function writeReceipt(root, receipt) {
  const directory = receiptDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = receiptFile(
    root, receipt.sourceCommit, receipt.platform, receipt.arch, recordedReceiptScope(receipt)
  );
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return target;
}

/** Execute only the exact, freshly recomputed and confirmed plan. */
export async function executeRepositoryReadinessPlan(root, {
  confirmation,
  runCommand = defaultRunCommand,
  environment = process.env,
  signal = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
  ...planOptions
} = {}) {
  const plan = await buildRepositoryReadinessPlan(root, planOptions);
  if (confirmation !== plan.planId) {
    throw new SingularityFlowError(
      `Repository readiness confirmation must equal the current plan digest ${plan.planId}.`,
      { code: 'REPOSITORY_READINESS_CONFIRMATION_MISMATCH', details: { required: plan.planId } }
    );
  }
  if (plan.blockers.length) {
    throw new SingularityFlowError(
      `Repository readiness plan has ${plan.blockers.length} unresolved blocker(s); no command was run.`,
      { code: 'REPOSITORY_READINESS_PLAN_BLOCKED', details: { blockers: plan.blockers } }
    );
  }
  const baseline = await captureWorkingTreeBaseline(root);
  if (baseline.commit !== plan.sourceCommit) throw new SingularityFlowError(
    'Repository HEAD changed after the readiness plan was created.',
    { code: 'REPOSITORY_READINESS_STALE_PLAN' }
  );
  const results = [];
  for (const command of plan.commands) {
    if (signal?.aborted) throw new SingularityFlowError('Repository readiness was cancelled.', {
      code: 'REPOSITORY_READINESS_CANCELLED'
    });
    const controller = new AbortController();
    const externalAbort = () => controller.abort('cancelled');
    signal?.addEventListener?.('abort', externalAbort, { once: true });
    const timer = setTimeoutFn(() => controller.abort('timeout'), command.timeoutMs);
    let result;
    try {
      result = await runCommand(command, {
        root, signal: controller.signal, environment, platform: plan.platform,
        setTimeoutFn, clearTimeoutFn, now
      });
    } catch (error) {
      throw new SingularityFlowError(`Repository readiness command '${command.id}' could not run.`, {
        code: 'REPOSITORY_READINESS_COMMAND_FAILED', cause: error,
        details: { commandId: command.id, purpose: command.purpose }
      });
    } finally {
      clearTimeoutFn(timer);
      signal?.removeEventListener?.('abort', externalAbort);
    }
    const record = sanitizedCommandResult(command, result);
    results.push(record);
    await assertWorkingTreeUnchanged(root, baseline);
    if (record.status !== 'pass') throw new SingularityFlowError(
      `Repository readiness command '${command.id}' failed.`,
      {
        code: 'REPOSITORY_READINESS_COMMAND_FAILED',
        details: { commandId: command.id, purpose: command.purpose, result: record }
      }
    );
  }
  await assertWorkingTreeUnchanged(root, baseline);
  const completedAt = new Date(now()).toISOString();
  const core = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: 'repository-readiness-receipt',
    scope: plan.scope,
    status: 'pass',
    sourceCommit: plan.sourceCommit,
    sourceManifestSha256: plan.sourceManifestSha256,
    repositoryFingerprint: plan.repositoryFingerprint,
    platform: plan.platform,
    arch: plan.arch,
    planId: plan.planId,
    executionPolicy: plan.executionPolicy,
    structuredTestContract: plan.structuredTestContract,
    commandResults: results,
    completedAt
  };
  const receipt = { ...core, receiptSha256: digest(core) };
  const file = await writeReceipt(root, receipt);
  return { plan, receipt, file };
}

function receiptIntegrity(receipt) {
  if (!receipt || receipt.kind !== 'repository-readiness-receipt') return false;
  const core = structuredClone(receipt);
  const supplied = core.receiptSha256;
  delete core.receiptSha256;
  return supplied === digest(core);
}

function planIdMatchesReceipt(plan, receipt) {
  if (receipt.scope !== undefined) return plan.planId === receipt.planId;
  const legacyCore = structuredClone(plan);
  delete legacyCore.planId;
  delete legacyCore.scope;
  return digest(legacyCore) === receipt.planId;
}

export async function loadRepositoryReadinessReceipt(root, {
  commit = head(root), platform = process.platform, arch = process.arch, scope = 'full',
  allowFullFallback = true
} = {}) {
  const requestedScope = readinessScope(scope);
  const candidateScopes = [requestedScope];
  if (requestedScope === 'dependency-test' && allowFullFallback) candidateScopes.push('full');
  for (const candidateScope of candidateScopes) {
    const file = receiptFile(root, commit, platform, arch, candidateScope);
    try {
      const receipt = readRecord(RECEIPT_FAMILY, await readFile(file)).record;
      const receiptScope = recordedReceiptScope(receipt);
      if (!receiptIntegrity(receipt)
          || receipt.sourceCommit !== String(commit).toLowerCase()
          || receipt.platform !== platform
          || receipt.arch !== arch
          || !scopeAllowsReceipt(requestedScope, receiptScope)
          || receiptScope !== candidateScope
          || !/^sha256:[0-9a-f]{64}$/u.test(receipt.planId ?? '')
          || !/^sha256:[0-9a-f]{64}$/u.test(receipt.sourceManifestSha256 ?? '')) {
        throw new SingularityFlowError(
          'Repository readiness receipt failed its integrity check.',
          { code: 'REPOSITORY_READINESS_RECEIPT_INVALID', details: { file } }
        );
      }
      return { receipt, file };
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (error instanceof SingularityFlowError) throw error;
      throw new SingularityFlowError('Repository readiness receipt is unreadable.', {
        code: 'REPOSITORY_READINESS_RECEIPT_INVALID', cause: error, details: { file }
      });
    }
  }
  return null;
}

/** Validate a Git-private receipt for the exact checked-out base commit and current source manifest. */
export async function inspectRepositoryReadinessReceipt(root, {
  commit = head(root), sourceManifestSha256 = null, platform = process.platform, arch = process.arch,
  recompute = sourceManifestSha256 === null, scope = 'full', allowFullFallback = true
} = {}) {
  const requestedScope = readinessScope(scope);
  const loaded = await loadRepositoryReadinessReceipt(root, {
    commit, platform, arch, scope: requestedScope, allowFullFallback
  });
  if (!loaded) return { status: 'missing', receipt: null, reasons: ['receipt-missing'] };
  const reasons = [];
  const { receipt } = loaded;
  const receiptScope = recordedReceiptScope(receipt);
  if (receipt.status !== 'pass') reasons.push('receipt-not-passing');
  if (receipt.sourceCommit !== commit) reasons.push('commit-mismatch');
  if (receipt.platform !== platform || receipt.arch !== arch) reasons.push('runtime-mismatch');
  let expectedManifest = sourceManifestSha256;
  let expectedPlanId = null;
  if (recompute) {
    if (head(root) !== commit) reasons.push('commit-not-checked-out');
    else {
      try {
        const currentPlan = await buildRepositoryReadinessPlan(root, {
          platform,
          arch,
          scope: receiptScope,
          timeouts: receipt.executionPolicy?.timeoutsMs,
          startSurvivalMs: receipt.executionPolicy?.startSurvivalMs
        });
        expectedManifest = currentPlan.sourceManifestSha256;
        expectedPlanId = planIdMatchesReceipt(currentPlan, receipt) ? receipt.planId : currentPlan.planId;
      } catch {
        reasons.push('current-plan-unavailable');
      }
    }
  }
  if (expectedManifest && receipt.sourceManifestSha256 !== expectedManifest) reasons.push('source-manifest-mismatch');
  if (expectedPlanId && receipt.planId !== expectedPlanId) reasons.push('plan-mismatch');
  return {
    status: reasons.length ? 'stale' : 'pass',
    receipt,
    file: loaded.file,
    reasons
  };
}

/**
 * Restore only the dependency layer inside an isolated Story worktree.
 *
 * The authoritative readiness run happened before the Story began. This helper does not create a
 * second receipt or reinterpret that run: it loads the exact machine-private receipt, reconstructs
 * the same plan against this checkout, and replays only dependency commands. Ignored caches may be
 * populated, while tracked and non-ignored untracked source bytes remain byte-for-byte unchanged.
 */
export async function hydrateRepositoryDependencies(root, {
  commit = head(root),
  required = false,
  runCommand = defaultRunCommand,
  environment = process.env,
  signal = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
  platform = process.platform,
  arch = process.arch,
  scope = 'full',
  allowFullFallback = true,
  ...planOptions
} = {}) {
  const currentCommit = head(root);
  if (currentCommit !== commit) throw new SingularityFlowError(
    `Dependency hydration requires checked-out commit ${commit}; current HEAD is ${currentCommit}.`,
    { code: 'REPOSITORY_READINESS_HYDRATION_COMMIT_MISMATCH' }
  );
  const requestedScope = readinessScope(scope);
  const loaded = await loadRepositoryReadinessReceipt(root, {
    commit, platform, arch, scope: requestedScope, allowFullFallback
  });
  if (!loaded) {
    if (required) throw new SingularityFlowError(
      `Dependency hydration requires a passing repository-readiness receipt for ${commit}.`,
      { code: 'REPOSITORY_READINESS_RECEIPT_REQUIRED' }
    );
    return {
      status: 'skipped', reason: 'receipt-missing', sourceCommit: commit,
      planId: null, commandResults: []
    };
  }
  const { receipt } = loaded;
  const receiptScope = recordedReceiptScope(receipt);
  if (receipt.status !== 'pass') throw new SingularityFlowError(
    'Dependency hydration requires a passing repository-readiness receipt.',
    { code: 'REPOSITORY_READINESS_RECEIPT_NOT_PASSING' }
  );
  const plan = await buildRepositoryReadinessPlan(root, {
    ...planOptions,
    platform,
    arch,
    scope: receiptScope,
    timeouts: receipt.executionPolicy?.timeoutsMs,
    startSurvivalMs: receipt.executionPolicy?.startSurvivalMs,
    requireStructuredTest: receipt.structuredTestContract?.requiredForCode
  });
  if (!planIdMatchesReceipt(plan, receipt)
      || plan.sourceCommit !== receipt.sourceCommit
      || plan.sourceManifestSha256 !== receipt.sourceManifestSha256) {
    throw new SingularityFlowError(
      'Dependency hydration plan does not match the exact pre-Story readiness receipt.',
      {
        code: 'REPOSITORY_READINESS_HYDRATION_STALE',
        details: {
          receiptPlanId: receipt.planId,
          currentPlanId: plan.planId,
          sourceManifestMatches: plan.sourceManifestSha256 === receipt.sourceManifestSha256
        }
      }
    );
  }
  if (plan.blockers.length) throw new SingularityFlowError(
    'Dependency hydration cannot replay a readiness plan with unresolved blockers.',
    { code: 'REPOSITORY_READINESS_PLAN_BLOCKED', details: { blockers: plan.blockers } }
  );
  const commands = plan.commands.filter((command) => command.purpose === 'dependency');
  if (!commands.length) {
    if (required) throw new SingularityFlowError(
      'Dependency hydration is required, but the exact readiness plan has no dependency command.',
      { code: 'REPOSITORY_READINESS_DEPENDENCY_REQUIRED' }
    );
    return {
      status: 'skipped', reason: 'no-dependency-commands', sourceCommit: commit,
      planId: plan.planId, commandResults: []
    };
  }
  const baseline = await captureWorkingTreeBaseline(root);
  const commandResults = [];
  for (const command of commands) {
    if (signal?.aborted) throw new SingularityFlowError('Dependency hydration was cancelled.', {
      code: 'REPOSITORY_READINESS_CANCELLED'
    });
    const controller = new AbortController();
    const externalAbort = () => controller.abort('cancelled');
    signal?.addEventListener?.('abort', externalAbort, { once: true });
    const timer = setTimeoutFn(() => controller.abort('timeout'), command.timeoutMs);
    let result;
    try {
      result = await runCommand(command, {
        root,
        signal: controller.signal,
        environment,
        platform,
        setTimeoutFn,
        clearTimeoutFn,
        now
      });
    } catch (error) {
      throw new SingularityFlowError(`Dependency hydration command '${command.id}' could not run.`, {
        code: 'REPOSITORY_READINESS_HYDRATION_FAILED',
        cause: error,
        details: { commandId: command.id }
      });
    } finally {
      clearTimeoutFn(timer);
      signal?.removeEventListener?.('abort', externalAbort);
    }
    const sanitized = sanitizedCommandResult(command, result, 'dependency');
    commandResults.push(sanitized);
    await assertWorkingTreeUnchanged(root, baseline);
    if (sanitized.status !== 'pass') throw new SingularityFlowError(
      `Dependency hydration command '${command.id}' failed.`,
      {
        code: 'REPOSITORY_READINESS_HYDRATION_FAILED',
        details: { commandId: command.id, result: sanitized }
      }
    );
  }
  await assertWorkingTreeUnchanged(root, baseline);
  return {
    status: 'pass',
    reason: null,
    sourceCommit: commit,
    planId: plan.planId,
    commandResults
  };
}

export const REPOSITORY_READINESS_PURPOSE_ORDER = PURPOSE_ORDER;
export const REPOSITORY_READINESS_DEFAULT_TIMEOUTS_MS = DEFAULT_TIMEOUTS_MS;
export const REPOSITORY_READINESS_SCOPES = READINESS_SCOPES;
