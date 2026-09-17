/**
 * Bounded REV pilot execution bridge. An agent may propose file edits, but it cannot supply
 * executable code, a command, a callback, an environment, or a process driver. The sole child is
 * this module's fixed worker. It has no Git, network, model, cache, or host-worktree operation.
 *
 * This is a low-level effect boundary, not candidate admission or publication. The caller must
 * independently bind parent bytes to a retained candidate and run scope/secret/policy precheck.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applicationPathContext, isApplicationPath } from '../application-paths.mjs';
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';

const MAX_FILES = 2_000;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EDIT_FILES = 128;
const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_WAIT_MS = 60_000;
const MAX_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 250;
const QUIESCE_WAIT_MS = 1_500;
const PLANS = new WeakMap();
const RESULT_BYTES = new WeakMap();
const RECOVERY = new WeakMap();

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }
function bytesHash(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value !== value.normalize('NFC')
      || value.startsWith('/') || value.includes('\\') || value.includes('\0')
      || value.split('/').some((part) => !part || part === '.' || part === '..' || part.length > 255
        || part.toLowerCase() === '.git' || /[\x00-\x1f\x7f:]/u.test(part))) {
    fail('REV_ATTEMPT_PATH_INVALID', 'Execution path is not a safe relative path.');
  }
  return value;
}

function safeEditPath(value) {
  const relative = safePath(value);
  const folded = relative.toLocaleLowerCase('en-US');
  if (folded === '.sflow' || folded.startsWith('.sflow/')
      || folded === '.singularity-flow' || folded.startsWith('.singularity-flow/')) {
    fail('REV_ATTEMPT_SCOPE_REFUSED', 'Revision control and local runtime state are not application edit targets.');
  }
  if (['.gitattributes', '.gitmodules'].includes(path.posix.basename(relative).toLowerCase())) {
    fail('REV_AGENT_GIT_MUTATION_DENIED', 'Git behavior metadata cannot be edited by an execution unit.');
  }
  if (!isApplicationPath(relative, { caseInsensitivePaths: true })) {
    fail('REV_ATTEMPT_SCOPE_REFUSED', 'Governed state is not an application edit target.');
  }
  return relative;
}

function allowedPathSet(values, context) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_EDIT_FILES) {
    fail('REV_ATTEMPT_SCOPE_INVALID', 'A bounded explicit allowed-path set is required.');
  }
  const result = new Set(values.map(safeEditPath));
  if (result.size !== values.length
      || new Set([...result].map((item) => item.toLocaleLowerCase('en-US'))).size !== result.size
      || [...result].some((item) => !isApplicationPath(item, context))) {
    fail('REV_ATTEMPT_SCOPE_REFUSED', 'Allowed paths overlap governed state or are ambiguous.');
  }
  return result;
}

function effectSet(values) {
  if (!Array.isArray(values) || new Set(values).size !== values.length
      || values.some((item) => typeof item !== 'string')) {
    fail('REV_EXTERNAL_EFFECT_UNKNOWN', 'Execution needs an explicit effect-class allowlist.');
  }
  const allowed = new Set(values);
  // Even a wait-only plan materializes its parent tree in a private candidate directory.
  const required = ['candidate-filesystem', 'local-process'];
  if (allowed.size !== required.length || required.some((item) => !allowed.has(item))) {
    fail('REV_EXTERNAL_EFFECT_UNKNOWN', 'Only the exact brokered local-process and candidate-filesystem effects are available.');
  }
  return [...allowed].sort();
}

/** Register a fixed-worker plan. No shell, raw Git, arbitrary JS, provider, or custom process. */
export function registerRevisionBrokeredExecutionPlan(operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > MAX_EDIT_FILES) {
    fail('REV_ATTEMPT_DRIVER_INVALID', 'A bounded nonempty brokered execution plan is required.');
  }
  const seen = new Set();
  let totalBytes = 0;
  const plan = operations.map((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      fail('REV_ATTEMPT_DRIVER_INVALID', 'Execution operations must be structured records.');
    }
    if (operation.kind === 'wait') {
      if (!Number.isSafeInteger(operation.ms) || operation.ms < 1 || operation.ms > MAX_WAIT_MS) {
        fail('REV_ATTEMPT_DRIVER_INVALID', 'Wait duration exceeds the execution bound.');
      }
      return { kind: 'wait', ms: operation.ms };
    }
    if (!['write', 'delete'].includes(operation.kind)) {
      const requestedCommand = String(operation.command ?? operation.argv?.[0] ?? operation.kind);
      fail(/^(?:git|\/[^\s]*\/git)(?:$|\s)/iu.test(requestedCommand)
        ? 'REV_AGENT_GIT_MUTATION_DENIED' : 'REV_ATTEMPT_DRIVER_UNSUPPORTED',
      'Raw commands, Git mutations, and custom execution units are not brokered.');
    }
    const relative = safeEditPath(operation.path);
    const folded = relative.toLocaleLowerCase('en-US');
    if (seen.has(folded)) fail('REV_ATTEMPT_DRIVER_INVALID', 'An edit path may occur only once.');
    seen.add(folded);
    if (operation.kind === 'delete') return { kind: 'delete', path: relative };
    if (!Buffer.isBuffer(operation.bytes) && !(operation.bytes instanceof Uint8Array)) {
      fail('REV_ATTEMPT_DRIVER_INVALID', 'Write operations require exact bytes.');
    }
    const bytes = Buffer.from(operation.bytes);
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_EDIT_BYTES) {
      fail('REV_ATTEMPT_EFFECT_LIMIT', 'Brokered edit bytes exceed the pilot limit.');
    }
    return { kind: 'write', path: relative, bytes, executable: operation.executable === true };
  });
  const token = Object.freeze({ kind: 'revision-brokered-execution-plan/v1' });
  PLANS.set(token, plan);
  return token;
}

function validateParentFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) {
    fail('REV_ATTEMPT_TREE_LIMIT', 'Parent materialization exceeds the file limit.');
  }
  let totalBytes = 0;
  const seen = new Set();
  const result = files.map((file) => {
    const relative = safePath(file?.path);
    const folded = relative.toLowerCase();
    if (seen.has(folded) || (!Buffer.isBuffer(file?.bytes) && !(file?.bytes instanceof Uint8Array))) {
      fail('REV_ATTEMPT_TREE_UNSUPPORTED', 'Parent files are ambiguous or lack exact bytes.');
    }
    seen.add(folded);
    const bytes = Buffer.from(file.bytes);
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_TREE_BYTES) {
      fail('REV_ATTEMPT_TREE_LIMIT', 'Parent materialization exceeds the byte limit.');
    }
    return { path: relative, bytes, executable: file.executable === true };
  });
  return result;
}

async function materialize(workspace, files) {
  const before = new Map();
  for (const file of files) {
    const target = path.join(workspace, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
    await chmod(target, file.executable ? 0o700 : 0o600);
    before.set(file.path, { sha256: bytesHash(file.bytes), bytes: file.bytes.length,
      mode: file.executable ? '100755' : '100644' });
  }
  return before;
}

async function snapshot(workspace) {
  const files = new Map();
  const bytes = new Map();
  let totalBytes = 0;
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = safePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const target = path.join(directory, entry.name);
      const stat = await lstat(target);
      if (stat.isDirectory()) await walk(target, relative);
      else if (stat.isFile() && !stat.isSymbolicLink()) {
        totalBytes += stat.size;
        if (files.size >= MAX_FILES || stat.size > MAX_FILE_BYTES || totalBytes > MAX_TREE_BYTES) {
          fail('REV_ATTEMPT_EFFECT_LIMIT', 'Execution output exceeds the file or byte bound.');
        }
        const content = await readFile(target);
        files.set(relative, { sha256: bytesHash(content), bytes: content.length,
          mode: stat.mode & 0o111 ? '100755' : '100644' });
        bytes.set(relative, content);
      } else fail('REV_ATTEMPT_EFFECT_UNSUPPORTED', 'Execution produced a symlink or unsupported effect.');
    }
  }
  await walk(workspace);
  return { files, bytes };
}

// The worker is intentionally data-only. It never imports child_process, net, http, Git, or a
// model provider, and cannot load a script from candidate files. A fixed single worker has no
// descendants; its observed exit is therefore a process-tree quiescence proof for this contract.
const WORKER_SOURCE = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const parts = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) process.exit(72);
    parts.push(chunk);
  }
  const operations = JSON.parse(Buffer.concat(parts).toString('utf8'));
  for (const operation of operations) {
    if (operation.kind === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, operation.ms));
    } else if (operation.kind === 'delete') {
      await fs.rm(path.join(process.cwd(), operation.path), { force: true });
    } else if (operation.kind === 'write') {
      const target = path.join(process.cwd(), operation.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, Buffer.from(operation.base64, 'base64'), { mode: 0o600 });
      await fs.chmod(target, operation.executable ? 0o700 : 0o600);
    } else process.exit(73);
  }
})().catch(() => process.exit(74));
`;

function workerOperations(plan) {
  return plan.map((operation) => operation.kind === 'write'
    ? { kind: 'write', path: operation.path, base64: operation.bytes.toString('base64'),
      executable: operation.executable }
    : { ...operation });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    let spawnError = null;
    child.once('error', (error) => {
      spawnError = error?.code ?? 'SPAWN_FAILED';
      // A failed spawn has no process tree. If a PID exists, only `exit` proves quiescence.
      if (child.pid == null) resolve({ error: spawnError, neverStarted: true });
    });
    child.once('exit', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
}

async function superviseWorker(workspace, plan, timeoutMs, signal) {
  if (signal?.aborted) return { reason: 'cancelled-before-start', started: false,
    quiescenceStatus: 'confirmed', stopOutcome: 'not-started' };
  const child = spawn(process.execPath, ['-e', WORKER_SOURCE], {
    cwd: workspace, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    env: { PATH: '', TMPDIR: workspace, TMP: workspace, TEMP: workspace, LANG: 'C' }
  });
  child.stdin.on('error', () => {});
  const pid = child.pid ?? null;
  const exit = waitForExit(child);
  let reason = null;
  let stopTimer;
  const stop = (cause) => {
    if (reason) return;
    reason = cause;
    try { child.kill('SIGTERM'); } catch { /* Exit observation remains authoritative. */ }
    stopTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* Exit observation remains authoritative. */ }
    }, STOP_GRACE_MS);
  };
  const deadline = setTimeout(() => stop('timed-out'), timeoutMs);
  const onAbort = () => stop('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  const payload = JSON.stringify(workerOperations(plan));
  child.stdin.end(payload);
  let outcome;
  let quiescenceTimer;
  try {
    outcome = await Promise.race([
      exit,
      new Promise((resolve) => {
        quiescenceTimer = setTimeout(() => resolve({ unobserved: true }), timeoutMs + QUIESCE_WAIT_MS);
      })
    ]);
  } finally {
    clearTimeout(deadline);
    clearTimeout(stopTimer);
    clearTimeout(quiescenceTimer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (outcome.unobserved) {
    try { child.kill('SIGKILL'); } catch { /* Recovery still required. */ }
    return { reason: reason ?? 'process-not-quiesced', started: true, pid,
      quiescenceStatus: 'unknown', stopOutcome: 'unobserved', child, exit };
  }
  return { reason, started: pid !== null, pid,
    quiescenceStatus: 'confirmed', stopOutcome: outcome.error ? 'not-started'
      : outcome.signal ? 'signalled' : 'exited', exitCode: outcome.code ?? null,
    signal: outcome.signal ?? null };
}

function changesBetween(before, after, allowed, context) {
  const changes = [];
  for (const relative of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const prior = before.get(relative) ?? null;
    const next = after.get(relative) ?? null;
    if (hash(prior) === hash(next)) continue;
    if (!allowed.has(relative) || !isApplicationPath(relative, context)) {
      fail('REV_ATTEMPT_SCOPE_VIOLATION', 'Execution changed a path outside its exact allowlist.');
    }
    changes.push({ path: relative, before: prior, after: next });
    if (changes.length > MAX_EDIT_FILES) fail('REV_ATTEMPT_EFFECT_LIMIT', 'Too many output changes.');
  }
  return changes;
}

function receipt({ attemptId, status, code, process, changes, cleanupVerified,
  parentSha256, planSha256, allowedEffects }) {
  const processQuiescent = process?.quiescenceStatus === 'confirmed';
  const effectsResolved = cleanupVerified === true && processQuiescent;
  const completeInventory = status === 'bounded-effects-collected';
  const effects = [
    {
      class: 'local-process', observed: process?.started === true,
      stopOutcome: process?.stopOutcome ?? 'not-started',
      quiescenceStatus: process?.quiescenceStatus ?? 'confirmed',
      resolutionStatus: processQuiescent ? 'absent' : 'unknown',
      processTreeSha256: process?.started
        ? hash({ attemptId, pid: process.pid, planSha256, singleFixedWorker: true }) : null
    },
    {
      // Even an empty delta materializes a private candidate directory before execution.
      class: 'candidate-filesystem', observed: true,
      resolutionStatus: cleanupVerified ? 'restored' : 'unknown',
      effectSetSha256: completeInventory ? hash(changes) : null
    }
  ];
  const unknownEffects = [];
  if (!processQuiescent) unknownEffects.push('local-process');
  if (!cleanupVerified) unknownEffects.push('candidate-filesystem');
  const core = {
    schemaVersion: 1, kind: 'revision-effect-receipt', attemptId, status,
    ...(code ? { code } : {}), parentSha256, planSha256, allowedEffects,
    effects, unknownEffects, changes, cleanup: { verified: cleanupVerified },
    retryAllowed: ['refused', 'failed', 'timed-out', 'cancelled'].includes(status) && effectsResolved,
    candidateAdmitted: false, loopHeadAdvanced: false
  };
  return { ...core, receiptSha256: hash(core) };
}

/**
 * Execute one exact byte plan in a disposable workspace. Preflight failures throw before spawn;
 * every started attempt returns an effect receipt. A successful result is still unadmitted.
 */
export async function executeRevisionBrokeredPlan({
  plan, parentFiles, allowedPaths, allowedEffects, config, workflow,
  timeoutMs = MAX_TIMEOUT_MS, signal
} = {}) {
  const operations = plan && PLANS.get(plan);
  if (!operations) fail('REV_ATTEMPT_DRIVER_UNSUPPORTED', 'Only an opaque registered brokered plan can execute.');
  if (!config || typeof config !== 'object' || !workflow || typeof workflow !== 'object') {
    fail('REV_ATTEMPT_SCOPE_INVALID', 'Configuration and workflow are required.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail('REV_ATTEMPT_BUDGET_EXHAUSTED', 'Execution timeout exceeds the pilot bound.');
  }
  // A candidate may later be inspected on a case-insensitive filesystem, regardless of the
  // host running this bridge. Keep protected-path decisions portable across those machines.
  const context = Object.freeze({ ...applicationPathContext(config, workflow), caseInsensitivePaths: true });
  const allowed = allowedPathSet(allowedPaths, context);
  const effectClasses = effectSet(allowedEffects);
  for (const operation of operations) {
    if (operation.kind !== 'wait' && (!allowed.has(operation.path)
        || !isApplicationPath(operation.path, context))) {
      fail('REV_ATTEMPT_SCOPE_REFUSED', 'Brokered edit is outside exact application scope.');
    }
  }
  const files = validateParentFiles(parentFiles);
  const parentSha256 = hash(files.map((file) => ({ path: file.path,
    sha256: bytesHash(file.bytes), executable: file.executable })));
  const planSha256 = hash(workerOperations(operations));
  const attemptId = `REVBR-${randomUUID()}`;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-bridge-'));
  const workspace = path.join(temporary, 'candidate');
  let process = null;
  let status = 'refused';
  let code = null;
  let changes = [];
  let resultBytes = null;
  let cleanupVerified = false;
  try {
    await chmod(temporary, 0o700);
    await mkdir(workspace, { mode: 0o700 });
    const before = await materialize(workspace, files);
    process = await superviseWorker(workspace, operations, timeoutMs, signal);
    if (process.quiescenceStatus !== 'confirmed') {
      status = 'recovery-required';
      code = 'REV_PROCESS_NOT_QUIESCED';
    } else if (process.reason) {
      status = process.reason === 'timed-out' ? 'timed-out' : 'cancelled';
      code = process.reason === 'timed-out' ? 'REV_ATTEMPT_BUDGET_EXHAUSTED' : 'REV_ATTEMPT_CANCELLED';
    } else if (process.exitCode !== 0) {
      status = 'failed';
      code = 'REV_ATTEMPT_EXECUTION_FAILED';
    } else {
      const after = await snapshot(workspace);
      changes = changesBetween(before, after.files, allowed, context);
      resultBytes = new Map(changes.map((change) =>
        [change.path, change.after ? Buffer.from(after.bytes.get(change.path)) : null]));
      status = 'bounded-effects-collected';
    }
  } catch (error) {
    status = process ? 'recovery-required' : 'refused';
    code = error?.code ?? 'REV_ATTEMPT_UNCERTAIN_EFFECTS';
  } finally {
    if (process?.quiescenceStatus !== 'unknown') {
      try {
        await rm(temporary, { recursive: true, force: true });
        try { await lstat(temporary); }
        catch (error) { if (error?.code === 'ENOENT') cleanupVerified = true; }
      } catch { cleanupVerified = false; }
    }
  }
  if (!cleanupVerified) {
    status = 'recovery-required';
    code = process?.quiescenceStatus === 'unknown'
      ? 'REV_PROCESS_NOT_QUIESCED' : 'REV_ATTEMPT_ROLLBACK_FAILED';
  }
  const result = receipt({ attemptId, status, code, process, changes, cleanupVerified,
    parentSha256, planSha256, allowedEffects: effectClasses });
  if (status === 'bounded-effects-collected' && resultBytes) {
    RESULT_BYTES.set(result, { bytes: resultBytes, receiptSha256: result.receiptSha256 });
  }
  if (!cleanupVerified) RECOVERY.set(result, { temporary, process });
  return result;
}

/** Copy exact unadmitted result bytes only from the original in-process receipt object. */
export function readRevisionBrokeredResultBytes(receiptObject) {
  const handoff = receiptObject && RESULT_BYTES.get(receiptObject);
  const { receiptSha256, ...core } = receiptObject ?? {};
  if (!handoff || handoff.receiptSha256 !== receiptObject.receiptSha256
      || hash(core) !== receiptSha256
      || receiptObject.status !== 'bounded-effects-collected') {
    fail('REV_ATTEMPT_RESULT_UNVERIFIED', 'No exact brokered result is available for this receipt.');
  }
  return new Map([...handoff.bytes].map(([relative, bytes]) =>
    [relative, bytes === null ? null : Buffer.from(bytes)]));
}

/** Retry local cleanup of a same-process uncertain attempt; never claims external compensation. */
export async function recoverRevisionBrokeredPlan(receiptObject) {
  const pending = receiptObject && RECOVERY.get(receiptObject);
  if (!pending) fail('REV_RECOVERY_REQUIRED', 'No same-process recovery handle exists for this attempt.');
  const { temporary, process } = pending;
  if (process?.quiescenceStatus === 'unknown') {
    try { process.child.kill('SIGKILL'); } catch { /* Exit proof still needed. */ }
    const observed = await Promise.race([
      process.exit,
      new Promise((resolve) => setTimeout(() => resolve({ unobserved: true }), QUIESCE_WAIT_MS))
    ]);
    if (observed.unobserved) return { status: 'recovery-required', code: 'REV_PROCESS_NOT_QUIESCED' };
  }
  try {
    await rm(temporary, { recursive: true, force: true });
    try { await lstat(temporary); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        RECOVERY.delete(receiptObject);
        const core = {
          schemaVersion: 1, kind: 'revision-effect-recovery-receipt',
          attemptId: receiptObject.attemptId,
          originalReceiptSha256: receiptObject.receiptSha256,
          status: 'recovered', processTreeQuiescent: true,
          candidateFilesystemRestored: true, externalEffectsCompensated: 'not-applicable',
          retryAllowed: true
        };
        return { ...core, recoverySha256: hash(core) };
      }
    }
  } catch { /* Keep the recovery handle. */ }
  return { status: 'recovery-required', code: 'REV_ATTEMPT_ROLLBACK_FAILED' };
}
