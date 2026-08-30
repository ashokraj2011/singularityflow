/**
 * Immutable Git-backed SGOS Candidate lifecycle.
 *
 * Candidate data is retained by a hidden Git ref. Verification runs in an isolated detached
 * worktree, and publication advances the selected local branch with compare-and-swap. Nothing in
 * this module gives a candidate authority merely because it is self-hashed: publication requires
 * a passed verification receipt and an exact publication-plan confirmation.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  branch, exactRemoteBranchObservation, gitCommonDir, head, hasRemote, pushCommitToBranch
} from '../git.mjs';
import { configuredRemoteAuthority } from '../git-remote-diagnostics.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import {
  createCandidateSnapshot, sha256, validateCandidateSnapshot
} from './contracts.mjs';
import { compareSgosCodePoints } from './order.mjs';
import {
  listPrivateSidecar, readPrivateSidecar, safePrivateSidecarDirectory,
  writeImmutablePrivateSidecar
} from './private-sidecar.mjs';

const CANDIDATE_ID = /^CAN-[A-Za-z0-9._:-]{6,127}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const BRANCH = /^(?!-)(?!.*(?:\.\.|@\{|\\|\s|[~^:?*\[]))(?!.*\.$)[A-Za-z0-9._/-]+$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CANDIDATE_FILES = 20_000;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_CANDIDATE_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_COMMANDS = 32;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const CANDIDATE_RECORD_FORMAT = 'sflow.sgos.candidate-private';
const CANDIDATE_RECORD_VERSION = 1;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function candidateRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'candidates');
}

function candidateDirectory(root, candidateId) {
  if (!CANDIDATE_ID.test(String(candidateId ?? ''))) {
    fail('Candidate ID is invalid.', 'SGOS_CANDIDATE_ID_INVALID', { candidateId });
  }
  return path.join(candidateRoot(root), candidateId);
}

function candidateRecordPath(root, candidateId) {
  return path.join(candidateDirectory(root, candidateId), 'candidate.json');
}

function verificationDirectory(root, candidateId) {
  return path.join(candidateDirectory(root, candidateId), 'verification');
}

function publicationDirectory(root, candidateId) {
  return path.join(candidateDirectory(root, candidateId), 'publication');
}

function publicationPlanDirectory(root, candidateId) {
  return path.join(candidateDirectory(root, candidateId), 'publication-plans');
}

function gitResult(root, args, { env = process.env, input = null, maximumBytes = 32 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    input,
    encoding: null,
    maxBuffer: maximumBytes,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const diagnostic = Buffer.from(result.stderr ?? '').toString('utf8').slice(0, 4096).trim();
    fail(`Git candidate operation failed${diagnostic ? `: ${diagnostic}` : '.'}`,
      'SGOS_CANDIDATE_GIT_FAILED', { status: result.status, signal: result.signal ?? null });
  }
  return Buffer.from(result.stdout ?? '');
}

function tryGitResult(root, args, { env = process.env, input = null, maximumBytes = 32 * 1024 * 1024 } = {}) {
  return spawnSync('git', args, {
    cwd: root,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    input,
    encoding: null,
    maxBuffer: maximumBytes,
    windowsHide: true
  });
}

function gitText(root, args, options = {}) {
  return gitResult(root, args, options).toString('utf8').trim();
}

function parseNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const from = fields[index++];
      const to = fields[index++];
      if (!from || !to) fail('Git returned an incomplete rename/copy record.', 'SGOS_CANDIDATE_GIT_INVALID');
      changes.push({ kind, from, path: to });
    } else {
      const changedPath = fields[index++];
      if (!changedPath) fail('Git returned an incomplete candidate path record.', 'SGOS_CANDIDATE_GIT_INVALID');
      changes.push({ kind, from: null, path: changedPath });
    }
  }
  return changes;
}

function treeEntry(root, tree, relative) {
  const raw = gitResult(root, ['ls-tree', '-z', tree, '--', relative]).toString('utf8');
  if (!raw) return null;
  const tab = raw.indexOf('\t');
  const header = raw.slice(0, tab).split(' ');
  const actual = raw.slice(tab + 1).replace(/\0$/, '');
  if (header.length !== 3 || actual !== relative) {
    fail('Candidate tree returned an ambiguous path entry.', 'SGOS_CANDIDATE_GIT_INVALID', { path: relative });
  }
  const [mode, objectType, object] = header;
  if (!['100644', '100755', '120000'].includes(mode) || objectType !== 'blob' || !GIT_OBJECT.test(object)) {
    fail(`Candidate path '${relative}' has unsupported Git type or mode.`,
      'SGOS_CANDIDATE_RESOURCE_UNSUPPORTED', { path: relative, mode, objectType });
  }
  const bytes = gitResult(root, ['cat-file', 'blob', object], { maximumBytes: MAX_CANDIDATE_BYTES });
  return { mode, object, bytes };
}

function candidateResources(root, baseline, tree) {
  const changes = parseNameStatus(gitResult(root, [
    'diff', '--name-status', '-z', '--find-renames', '--find-copies', baseline, tree, '--'
  ]));
  if (changes.length > MAX_CANDIDATE_FILES) {
    fail('Candidate exceeds the installed file-count ceiling.', 'SGOS_CANDIDATE_LIMIT', {
      files: changes.length, maximumFiles: MAX_CANDIDATE_FILES
    });
  }
  let totalBytes = 0;
  const resources = changes.map((change) => {
    if (change.kind === 'D') {
      const prior = treeEntry(root, baseline, change.path);
      if (!prior) {
        fail(`Deleted Candidate path '${change.path}' is absent from its bound baseline.`,
          'SGOS_CANDIDATE_GIT_INVALID');
      }
      return {
        path: change.path, type: prior.mode === '120000' ? 'symlink' : 'file',
        mode: null, contentSha256: null,
        operation: 'deleted', renameFrom: null, renameTo: null, deletion: true
      };
    }
    const entry = treeEntry(root, tree, change.path);
    if (!entry) fail(`Candidate path '${change.path}' disappeared from its retained tree.`, 'SGOS_CANDIDATE_GIT_INVALID');
    totalBytes += entry.bytes.length;
    if (totalBytes > MAX_CANDIDATE_BYTES) {
      fail('Candidate exceeds the installed byte ceiling.', 'SGOS_CANDIDATE_LIMIT', {
        bytes: totalBytes, maximumBytes: MAX_CANDIDATE_BYTES
      });
    }
    const operation = change.kind === 'A' ? 'added'
      : change.kind === 'R' ? 'renamed'
        : change.kind === 'C' ? 'copied'
          : change.kind === 'T' ? 'type-changed' : 'modified';
    // The core Candidate contract intentionally has no copy-from field. A copy is represented as
    // a copied target with no rename endpoints; the retained Git tree remains the byte authority.
    return {
      path: change.path,
      type: entry.mode === '120000' ? 'symlink' : 'file',
      mode: entry.mode,
      contentSha256: digestBytes(entry.bytes),
      operation,
      renameFrom: operation === 'renamed' ? change.from : null,
      renameTo: operation === 'renamed' ? change.path : null,
      deletion: false
    };
  }).sort((left, right) => compareSgosCodePoints(left.path, right.path));
  return { resources, totalBytes };
}

function temporaryIndexEnvironment(index) {
  return {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'Singularity Flow',
    GIT_AUTHOR_EMAIL: 'singularity-flow@localhost.invalid',
    GIT_COMMITTER_NAME: 'Singularity Flow',
    GIT_COMMITTER_EMAIL: 'singularity-flow@localhost.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
  };
}

async function worktreeTree(root) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-index-'));
  const index = path.join(temporary, 'index');
  const env = temporaryIndexEnvironment(index);
  try {
    gitResult(root, ['read-tree', 'HEAD'], { env });
    gitResult(root, ['add', '-A', '--', '.'], { env });
    const tree = gitText(root, ['write-tree'], { env });
    if (!GIT_OBJECT.test(tree)) fail('Git did not produce a retained candidate tree.', 'SGOS_CANDIDATE_GIT_INVALID');
    return tree;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function seal(kind, hashField, value) {
  // Candidate sidecars are private content-addressed Git-common records, not migration-registry
  // families. Keep that boundary explicit so a literal schemaVersion cannot masquerade as a
  // registered durable writer version.
  const core = {
    candidateRecordFormat: CANDIDATE_RECORD_FORMAT,
    candidateRecordVersion: CANDIDATE_RECORD_VERSION,
    kind,
    ...structuredClone(value)
  };
  delete core[hashField];
  return freezeDeep({ ...core, [hashField]: sha256(core) });
}

async function writeImmutable(root, target, record, hashField) {
  try {
    await writeImmutablePrivateSidecar(root, target, canonicalJson(record), {
      maximumBytes: MAX_CANDIDATE_RECORD_BYTES
    });
  } catch (error) {
    if (error?.code === 'SGOS_SIDECAR_RECORD_CONFLICT') {
      fail('An immutable candidate record already exists with different bytes.',
        'SGOS_CANDIDATE_RECORD_CONFLICT', { hash: record[hashField] });
    }
    throw error;
  }
  return record;
}

export async function freezeSgosCandidate(root, {
  subjectId = path.basename(root), createdBy, createdAt = nowIso()
} = {}) {
  if (!createdBy?.id || !createdBy?.kind) {
    fail('Candidate freeze requires a typed creator.', 'SGOS_CANDIDATE_CREATOR_REQUIRED');
  }
  // Establish the private authority path before creating the retained Git object/ref. A poisoned
  // sidecar parent must fail before any partial Candidate authority can be left behind.
  await safePrivateSidecarDirectory(root, candidateRoot(root), { create: true });
  const baselineCommit = head(root);
  const baselineTree = gitText(root, ['rev-parse', `${baselineCommit}^{tree}`]);
  const candidateTree = await worktreeTree(root);
  const { resources, totalBytes } = candidateResources(root, baselineCommit, candidateTree);
  const snapshot = createCandidateSnapshot({
    subject: { kind: 'repository-tree', id: subjectId },
    baseline: { revision: baselineCommit, snapshotSha256: digestBytes(Buffer.from(baselineTree)) },
    resources,
    createdBy,
    createdAt
  });
  const env = temporaryIndexEnvironment(path.join(os.tmpdir(), `unused-sflow-${process.pid}`));
  const message = `SGOS Candidate ${snapshot.candidateId}\n\nCandidate-SHA256: ${snapshot.candidateSha256}\n`;
  const candidateCommit = gitText(root, ['commit-tree', candidateTree, '-p', baselineCommit], {
    env, input: Buffer.from(message)
  });
  if (!GIT_OBJECT.test(candidateCommit)) fail('Git did not retain the candidate commit.', 'SGOS_CANDIDATE_GIT_INVALID');
  const retainedRef = `refs/singularity-flow/candidates/${snapshot.candidateId}`;
  // Candidate refs are immutable retention roots. A blind update would let a concurrent freeze
  // replace the ref before the immutable sidecar conflict is noticed, corrupting the older record.
  const zeroObject = '0'.repeat(candidateCommit.length);
  const created = tryGitResult(root, ['update-ref', retainedRef, candidateCommit, zeroObject]);
  if (created.error || created.status !== 0) {
    let observed = null;
    try { observed = gitText(root, ['rev-parse', '--verify', retainedRef]); } catch { /* report below */ }
    if (observed !== candidateCommit) {
      fail('Candidate retention ref already exists with different immutable bytes.',
        'SGOS_CANDIDATE_RECORD_CONFLICT', { retainedRef, observed, candidateCommit });
    }
  }
  const record = seal('sgos-retained-candidate', 'retainedCandidateSha256', {
    candidate: snapshot,
    repository: { baselineCommit, baselineTree, candidateTree, candidateCommit, retainedRef },
    totals: { files: resources.length, bytes: totalBytes }
  });
  await writeImmutable(root, candidateRecordPath(root, snapshot.candidateId), record,
    'retainedCandidateSha256');
  return record;
}

export async function readSgosRetainedCandidate(root, candidateId) {
  const target = candidateRecordPath(root, candidateId);
  let record;
  try {
    record = JSON.parse((await readPrivateSidecar(root, target, {
      maximumBytes: MAX_CANDIDATE_RECORD_BYTES
    })).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`Candidate '${candidateId}' was not found.`, 'SGOS_CANDIDATE_NOT_FOUND');
    throw error;
  }
  if (record?.candidateRecordFormat !== CANDIDATE_RECORD_FORMAT
      || record.candidateRecordVersion !== CANDIDATE_RECORD_VERSION
      || record?.kind !== 'sgos-retained-candidate'
      || record.retainedCandidateSha256 !== sha256(Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== 'retainedCandidateSha256')
      ))) {
    fail('Retained Candidate record failed its content hash.', 'SGOS_CANDIDATE_CORRUPT');
  }
  validateCandidateSnapshot(record.candidate);
  const repository = record.repository ?? {};
  for (const field of ['baselineCommit', 'baselineTree', 'candidateTree', 'candidateCommit']) {
    if (!GIT_OBJECT.test(String(repository[field] ?? ''))) {
      fail('Retained Candidate has an invalid Git object binding.', 'SGOS_CANDIDATE_CORRUPT', { field });
    }
  }
  const observedCommit = gitText(root, ['rev-parse', repository.retainedRef]);
  const observedTree = gitText(root, ['rev-parse', `${observedCommit}^{tree}`]);
  if (observedCommit !== repository.candidateCommit || observedTree !== repository.candidateTree) {
    fail('Candidate retention ref no longer names the frozen tree.', 'SGOS_CANDIDATE_RETENTION_LOST');
  }
  return freezeDeep(record);
}

export async function listSgosCandidates(root) {
  const entries = await listPrivateSidecar(root, candidateRoot(root), { optional: true });
  const records = [];
  for (const entry of entries.sort((a, b) => compareSgosCodePoints(a.name, b.name))) {
    if (!CANDIDATE_ID.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail('Candidate sidecar contains an unsafe record entry.',
        'SGOS_SIDECAR_PATH_UNSAFE', { entry: entry.name });
    }
    try { records.push(await readSgosRetainedCandidate(root, entry.name)); } catch (error) {
      records.push(freezeDeep({
        kind: 'sgos-candidate-unavailable', candidateId: entry.name,
        code: error?.code ?? 'SGOS_CANDIDATE_UNAVAILABLE', successClaimed: false
      }));
    }
  }
  return Object.freeze(records);
}

function normalizeVerificationCommands(commands) {
  if (!Array.isArray(commands) || !commands.length || commands.length > MAX_COMMANDS) {
    fail('Candidate verification requires a bounded non-empty command list.',
      'SGOS_CANDIDATE_VERIFICATION_INVALID', { maximumCommands: MAX_COMMANDS });
  }
  return commands.map((command, index) => {
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part)) {
      fail(`Candidate verification command ${index + 1} must be a non-empty argv array.`,
        'SGOS_CANDIDATE_VERIFICATION_INVALID');
    }
    if (!path.isAbsolute(command[0])) {
      fail(`Candidate verification command ${index + 1} executable must be an absolute path.`,
        'SGOS_CANDIDATE_VERIFICATION_INVALID');
    }
    return [...command];
  });
}

async function runBoundedCommand(command, cwd, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const allowedEnvironment = [
      'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec',
      'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'CI'
    ];
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: {
        ...Object.fromEntries(allowedEnvironment
          .filter((key) => Object.hasOwn(process.env, key))
          .map((key) => [key, process.env[key]])),
        GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'
      },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const chunks = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let forceTimer = null;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32' && child.pid) {
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T'], {
          stdio: 'ignore', windowsHide: true, timeout: 5_000
        });
        if (killed.status !== 0) child.kill('SIGTERM');
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      }
      forceTimer ??= setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === 'win32' && child.pid) {
          const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true, timeout: 5_000
          });
          if (killed.status !== 0) child.kill('SIGKILL');
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }, 2_000);
      forceTimer.unref?.();
    };
    const append = (chunk) => {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        overflow = true;
        terminate();
      } else chunks.push(value);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', reject);
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const abort = () => terminate();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) terminate();
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      const output = Buffer.concat(chunks);
      resolve({
        status: code ?? 1, signal: terminationSignal ?? null, timedOut,
        aborted: signal?.aborted === true, overflow, outputBytes: output.length,
        outputSha256: digestBytes(output)
      });
    });
  });
}

export async function verifySgosCandidate(root, candidateId, {
  commands, timeoutMs = 15 * 60 * 1000, signal = null, verifiedAt = nowIso()
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) {
    fail('Candidate verification timeout is outside the installed bounds.', 'SGOS_CANDIDATE_VERIFICATION_INVALID');
  }
  const retained = await readSgosRetainedCandidate(root, candidateId);
  await safePrivateSidecarDirectory(root, verificationDirectory(root, candidateId), {
    create: true
  });
  const normalized = normalizeVerificationCommands(commands);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-verify-'));
  const workspace = path.join(temporary, 'worktree');
  const results = [];
  try {
    // A linked worktree shares the application's Git common directory. Test code running there
    // could therefore mutate application refs or forge SGOS sidecars through ordinary Git
    // discovery. A non-local clone has an independent object database and ref namespace.
    gitResult(root, [
      'clone', '--no-local', '--no-checkout', '--no-tags', '--single-branch',
      '--branch', branch(root), '--', root, workspace
    ], { maximumBytes: MAX_CANDIDATE_BYTES });
    gitResult(workspace, [
      'fetch', '--no-tags', '--no-write-fetch-head', '--', root,
      `${retained.repository.retainedRef}:refs/singularity-flow/verification-candidate`
    ], { maximumBytes: MAX_CANDIDATE_BYTES });
    gitResult(workspace, ['remote', 'remove', 'origin']);
    gitResult(workspace, ['checkout', '--detach', retained.repository.candidateCommit, '--']);
    for (const command of normalized) {
      let executableInfo;
      try { executableInfo = await lstat(command[0]); } catch (error) {
        fail(`Candidate verification executable '${command[0]}' is unavailable.`,
          'SGOS_CANDIDATE_VERIFICATION_INVALID', { causeCode: error?.code ?? null });
      }
      if (!executableInfo.isFile() || executableInfo.isSymbolicLink()
          || executableInfo.size > MAX_CANDIDATE_BYTES) {
        fail(`Candidate verification executable '${command[0]}' is not a bounded regular file.`,
          'SGOS_CANDIDATE_VERIFICATION_INVALID');
      }
      const executableSha256 = digestBytes(await readFile(command[0]));
      const result = await runBoundedCommand(command, workspace, { timeoutMs, signal });
      results.push({ argvSha256: sha256(command), executableSha256, ...result });
      if (result.status !== 0 || result.timedOut || result.aborted || result.overflow) break;
    }
    const observedTree = gitText(workspace, ['rev-parse', 'HEAD^{tree}']);
    const observedWorkingTree = await worktreeTree(workspace);
    const untrackedOrModified = gitResult(workspace, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--'
    ]).length > 0;
    const passed = results.length === normalized.length
      && results.every((entry) => entry.status === 0 && !entry.timedOut && !entry.aborted && !entry.overflow)
      && observedTree === retained.repository.candidateTree
      && observedWorkingTree === retained.repository.candidateTree
      && !untrackedOrModified;
    const receipt = seal('candidate-verification-receipt', 'verificationReceiptSha256', {
      candidateId,
      candidateSha256: retained.candidate.candidateSha256,
      retainedCandidateSha256: retained.retainedCandidateSha256,
      candidateTree: retained.repository.candidateTree,
      commandSetSha256: sha256(normalized),
      results,
      workspaceIntegrity: {
        expectedTree: retained.repository.candidateTree,
        observedHeadTree: observedTree,
        observedWorkingTree,
        clean: !untrackedOrModified
      },
      status: passed ? 'passed' : 'failed',
      verifiedAt
    });
    const target = path.join(verificationDirectory(root, candidateId),
      `${receipt.verificationReceiptSha256.slice('sha256:'.length)}.json`);
    await writeImmutable(root, target, receipt, 'verificationReceiptSha256');
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function passedVerificationReceipts(root, candidateId) {
  const entries = await listPrivateSidecar(root, verificationDirectory(root, candidateId), {
    optional: true
  });
  const values = [];
  for (const entry of entries.sort((a, b) => compareSgosCodePoints(a.name, b.name))) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail('Candidate verification sidecar contains an unsafe record entry.',
        'SGOS_SIDECAR_PATH_UNSAFE', { entry: entry.name });
    }
    const value = JSON.parse((await readPrivateSidecar(
      root, path.join(verificationDirectory(root, candidateId), entry.name), {
        maximumBytes: MAX_CANDIDATE_RECORD_BYTES
      }
    )).toString('utf8'));
    const hash = sha256(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'verificationReceiptSha256')));
    const expectedKeys = [
      'candidateId', 'candidateRecordFormat', 'candidateRecordVersion', 'candidateSha256',
      'candidateTree', 'commandSetSha256', 'kind', 'results', 'retainedCandidateSha256',
      'status', 'verificationReceiptSha256', 'verifiedAt', 'workspaceIntegrity'
    ];
    const exactShape = value && typeof value === 'object' && !Array.isArray(value)
      && canonicalJson(Object.keys(value).sort()) === canonicalJson(expectedKeys.sort());
    const filenameDigest = `sha256:${entry.name.slice(0, -'.json'.length)}`;
    if (!exactShape || value.kind !== 'candidate-verification-receipt'
        || value.candidateRecordFormat !== CANDIDATE_RECORD_FORMAT
        || value.candidateRecordVersion !== CANDIDATE_RECORD_VERSION
        || value.candidateId !== candidateId || value.verificationReceiptSha256 !== hash
        || value.verificationReceiptSha256 !== filenameDigest
        || !HASH.test(String(value.candidateSha256 ?? ''))
        || !GIT_OBJECT.test(String(value.candidateTree ?? ''))
        || !HASH.test(String(value.commandSetSha256 ?? ''))
        || !Array.isArray(value.results) || !value.results.length || value.results.length > MAX_COMMANDS
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(value.verifiedAt ?? ''))) {
      fail('Candidate verification receipt is corrupt.', 'SGOS_CANDIDATE_VERIFICATION_CORRUPT');
    }
    const integrity = value.workspaceIntegrity;
    const passedShape = integrity && integrity.clean === true
      && integrity.expectedTree === value.candidateTree
      && integrity.observedHeadTree === value.candidateTree
      && integrity.observedWorkingTree === value.candidateTree
      && value.results.every((result) => result?.status === 0 && result.timedOut === false
        && result.aborted === false && result.overflow === false
        && HASH.test(String(result.argvSha256 ?? ''))
        && HASH.test(String(result.executableSha256 ?? ''))
        && HASH.test(String(result.outputSha256 ?? '')));
    if (value.status === 'passed' && !passedShape) {
      fail('Candidate passed-verification receipt contradicts its bound evidence.',
        'SGOS_CANDIDATE_VERIFICATION_CORRUPT');
    }
    if (value.status === 'passed') values.push(freezeDeep(value));
  }
  return values.sort((left, right) => compareSgosCodePoints(left.verifiedAt, right.verifiedAt)
    || compareSgosCodePoints(left.verificationReceiptSha256, right.verificationReceiptSha256));
}

export async function planSgosCandidatePublication(root, candidateId, {
  targetBranch = branch(root), remote = null
} = {}) {
  const retained = await readSgosRetainedCandidate(root, candidateId);
  if (!BRANCH.test(String(targetBranch ?? ''))) fail('Candidate target branch is invalid.', 'SGOS_CANDIDATE_TARGET_INVALID');
  if (remote !== null && !REMOTE.test(String(remote))) {
    fail('Candidate remote name is invalid.', 'SGOS_CANDIDATE_REMOTE_INVALID');
  }
  const receipts = await passedVerificationReceipts(root, candidateId);
  const verification = receipts.at(-1) ?? null;
  if (!verification || verification.candidateSha256 !== retained.candidate.candidateSha256
      || verification.candidateTree !== retained.repository.candidateTree) {
    fail('Candidate has no exact passed verification receipt.', 'SGOS_CANDIDATE_VERIFICATION_REQUIRED');
  }
  const currentBranch = branch(root);
  const currentHead = head(root);
  const currentTree = await worktreeTree(root);
  let remoteTargetCommit = null;
  let remoteAuthorityFingerprint = null;
  if (remote !== null) {
    if (!hasRemote(root, remote)) fail(`Git remote '${remote}' is not configured.`, 'SGOS_CANDIDATE_REMOTE_INVALID');
    const authority = configuredRemoteAuthority(root, remote, { direction: 'push' });
    if (!authority.url || !authority.fingerprint) {
      fail(`Git remote '${remote}' has no exact push authority.`, 'SGOS_CANDIDATE_REMOTE_INVALID');
    }
    const observed = exactRemoteBranchObservation(root, authority.url, targetBranch);
    if (!observed.reachable || observed.malformed) {
      fail(`Git remote '${remote}' cannot provide one exact '${targetBranch}' tip.`,
        'SGOS_CANDIDATE_REMOTE_INVALID');
    }
    remoteTargetCommit = observed.sha;
    remoteAuthorityFingerprint = authority.fingerprint;
  }
  const plan = seal('candidate-publication-plan', 'packetSha256', {
    candidateId,
    candidateSha256: retained.candidate.candidateSha256,
    verificationReceiptSha256: verification.verificationReceiptSha256,
    targetBranch,
    expectedTargetCommit: retained.repository.baselineCommit,
    candidateCommit: retained.repository.candidateCommit,
    candidateTree: retained.repository.candidateTree,
    remote,
    preconditions: {
      currentBranch,
      currentHead,
      worktreeTree: currentTree,
      remoteTargetCommit,
      remoteAuthorityFingerprint,
      branchMatches: currentBranch === targetBranch,
      baselineMatches: currentHead === retained.repository.baselineCommit,
      worktreeMatches: currentTree === retained.repository.candidateTree
    }
  });
  await writeImmutable(root, path.join(publicationPlanDirectory(root, candidateId),
    `${plan.packetSha256.slice('sha256:'.length)}.json`), plan, 'packetSha256');
  return plan;
}

async function readSgosCandidatePublicationPlan(root, candidateId, packetSha256) {
  if (!HASH.test(String(packetSha256 ?? ''))) {
    fail('Candidate publication packet SHA-256 is invalid.',
      'SGOS_CANDIDATE_PUBLICATION_CONFIRMATION_REQUIRED');
  }
  let plan;
  try {
    plan = JSON.parse((await readPrivateSidecar(root,
      path.join(publicationPlanDirectory(root, candidateId),
        `${packetSha256.slice('sha256:'.length)}.json`), {
        maximumBytes: MAX_CANDIDATE_RECORD_BYTES
      })).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('Candidate publication plan is missing; preview it again.',
        'SGOS_CANDIDATE_PUBLICATION_STALE', { packetSha256 });
    }
    throw error;
  }
  const expected = sha256(Object.fromEntries(
    Object.entries(plan).filter(([key]) => key !== 'packetSha256')
  ));
  if (plan.candidateRecordFormat !== CANDIDATE_RECORD_FORMAT
      || plan.candidateRecordVersion !== CANDIDATE_RECORD_VERSION
      || plan.kind !== 'candidate-publication-plan' || plan.packetSha256 !== expected
      || plan.packetSha256 !== packetSha256 || plan.candidateId !== candidateId) {
    fail('Candidate publication plan failed its exact content binding.',
      'SGOS_CANDIDATE_PUBLICATION_STALE', { packetSha256 });
  }
  return freezeDeep(plan);
}

export async function publishSgosCandidate(root, candidateId, {
  confirmationSha256, targetBranch = branch(root), remote = null, publishedAt = nowIso()
} = {}) {
  if (!HASH.test(String(confirmationSha256 ?? ''))) {
    fail('Candidate publication requires the exact publication packet SHA-256.',
      'SGOS_CANDIDATE_PUBLICATION_CONFIRMATION_REQUIRED');
  }
  let plan;
  try {
    plan = await readSgosCandidatePublicationPlan(root, candidateId, confirmationSha256);
  } catch (error) {
    if (error?.code !== 'SGOS_CANDIDATE_PUBLICATION_STALE') throw error;
    const preview = await planSgosCandidatePublication(root, candidateId, { targetBranch, remote });
    if (preview.packetSha256 !== confirmationSha256) {
      fail(`Candidate publication confirmation must equal ${preview.packetSha256}.`,
        'SGOS_CANDIDATE_PUBLICATION_STALE', { expected: preview.packetSha256 });
    }
    plan = preview;
  }
  if (plan.targetBranch !== targetBranch || plan.remote !== remote) {
    fail('Candidate publication target differs from the confirmed plan.',
      'SGOS_CANDIDATE_PUBLICATION_STALE', {
        expected: { targetBranch: plan.targetBranch, remote: plan.remote },
        received: { targetBranch, remote }
      });
  }
  // A publication receipt is part of the local transaction. Refuse a redirected receipt path
  // before the branch compare-and-swap can make the Candidate visible.
  await safePrivateSidecarDirectory(root, publicationDirectory(root, candidateId), {
    create: true
  });
  const currentBranch = branch(root);
  const currentHead = head(root);
  const currentTree = await worktreeTree(root);
  const alreadyPublished = currentBranch === plan.targetBranch
    && currentHead === plan.candidateCommit && currentTree === plan.candidateTree;
  const readyToPublish = currentBranch === plan.preconditions.currentBranch
    && currentHead === plan.preconditions.currentHead
    && currentTree === plan.preconditions.worktreeTree
    && plan.preconditions.branchMatches
    && plan.preconditions.baselineMatches
    && plan.preconditions.worktreeMatches;
  if (!readyToPublish && !alreadyPublished) {
    fail('Candidate publication preconditions changed; preview a new exact plan.',
      'SGOS_CANDIDATE_PUBLICATION_STALE', {
        preconditions: plan.preconditions,
        observed: { currentBranch, currentHead, worktreeTree: currentTree }
      });
  }
  let remoteObservation = null;
  let remoteAuthority = null;
  let remotePreflightFailure = null;
  if (remote != null) {
    if (!hasRemote(root, remote)) {
      if (!alreadyPublished) {
        fail(`Git remote '${remote}' is not configured.`, 'SGOS_CANDIDATE_REMOTE_INVALID');
      }
      remotePreflightFailure = { code: 'remote-not-configured' };
    } else {
      remoteAuthority = configuredRemoteAuthority(root, remote, { direction: 'push' });
      if (!remoteAuthority.url || remoteAuthority.fingerprint !== plan.preconditions.remoteAuthorityFingerprint) {
        if (!alreadyPublished) {
          fail('Candidate remote authority changed after publication confirmation.',
            'SGOS_CANDIDATE_PUBLICATION_STALE');
        }
        remotePreflightFailure = { code: 'remote-authority-changed' };
      }
      remoteObservation = remotePreflightFailure
        ? null
        : exactRemoteBranchObservation(root, remoteAuthority.url, targetBranch);
      if (!remotePreflightFailure && (!remoteObservation.reachable || remoteObservation.malformed)) {
        if (!alreadyPublished) {
          fail(`Git remote '${remote}' cannot provide one exact '${targetBranch}' tip.`,
            'SGOS_CANDIDATE_REMOTE_INVALID');
        }
        remotePreflightFailure = {
          code: remoteObservation.malformed ? 'remote-advertisement-malformed' : 'remote-unreachable'
        };
      } else if (!remotePreflightFailure && remoteObservation.sha !== plan.candidateCommit
          && remoteObservation.sha !== plan.preconditions.remoteTargetCommit) {
        if (!alreadyPublished) {
          fail('Candidate remote target changed after publication confirmation.',
            'SGOS_CANDIDATE_PUBLICATION_STALE', {
              expected: plan.preconditions.remoteTargetCommit,
              observed: remoteObservation.sha
            });
        }
        remotePreflightFailure = {
          code: 'remote-target-changed',
          expectedCommit: plan.preconditions.remoteTargetCommit,
          observedCommit: remoteObservation.sha
        };
      }
    }
  }
  if (!alreadyPublished) {
    gitResult(root, ['update-ref', `refs/heads/${targetBranch}`, plan.candidateCommit, plan.expectedTargetCommit]);
    // The worktree was proven byte-identical to the Candidate; align only the index to the new HEAD.
    gitResult(root, ['read-tree', plan.candidateCommit]);
  }
  const publishedTree = gitText(root, ['rev-parse', 'HEAD^{tree}']);
  if (head(root) !== plan.candidateCommit || publishedTree !== plan.candidateTree) {
    fail('Local publication does not equal the verified Candidate tree.', 'SGOS_CANDIDATE_PUBLICATION_MISMATCH');
  }
  let remoteResult = null;
  if (remote != null) {
    if (remotePreflightFailure) {
      remoteResult = {
        remote, priorCommit: plan.preconditions.remoteTargetCommit,
        status: 1, pushed: false, recovered: alreadyPublished,
        failure: remotePreflightFailure
      };
    } else if (remoteObservation.sha === plan.candidateCommit) {
      remoteResult = {
        remote, priorCommit: plan.preconditions.remoteTargetCommit,
        status: 0, pushed: true, recovered: true, failure: null
      };
    } else {
      const pushed = pushCommitToBranch(root, remote, plan.candidateCommit, targetBranch, {
        expectedRemoteSha: plan.preconditions.remoteTargetCommit,
        transportRemote: remoteAuthority.url,
        upstreamRemote: remote
      });
      remoteResult = {
        remote, priorCommit: plan.preconditions.remoteTargetCommit,
        status: pushed.status,
        pushed: pushed.status === 0,
        recovered: false,
        failure: pushed.status === 0 ? null : pushed.failure ?? null
      };
    }
  }
  const receipt = seal('candidate-publication-receipt', 'publicationReceiptSha256', {
    candidateId,
    candidateSha256: plan.candidateSha256,
    verificationReceiptSha256: plan.verificationReceiptSha256,
    packetSha256: plan.packetSha256,
    targetBranch,
    priorCommit: plan.expectedTargetCommit,
    publishedCommit: plan.candidateCommit,
    publishedTree,
    remote: remoteResult,
    status: remoteResult && !remoteResult.pushed ? 'local-published-remote-pending' : 'published',
    publishedAt
  });
  const target = path.join(publicationDirectory(root, candidateId),
    `${receipt.publicationReceiptSha256.slice('sha256:'.length)}.json`);
  await writeImmutable(root, target, receipt, 'publicationReceiptSha256');
  return receipt;
}

export function candidateDiffArguments(retained) {
  return Object.freeze([
    'diff', '--find-renames', retained.repository.baselineCommit, retained.repository.candidateCommit, '--'
  ]);
}
