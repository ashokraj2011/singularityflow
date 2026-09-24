/**
 * Machine-local cleanup queue for read-only repository-onboarding snapshots.
 *
 * Windows virus scanners and indexers can retain a directory handle after Git exits. A completed
 * authority read must not be replaced by that local EBUSY, but abandoning the checkout forever is
 * also incorrect. Queue only exact SFlow-owned mkdtemp paths and retry a bounded rotating set on a
 * later onboarding inspection. Nothing here is repository authority or part of a confirmation
 * digest.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  chmod, lstat, mkdir, readFile, readdir, realpath, rm
} from 'node:fs/promises';

import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { removeTemporaryTree, SingularityFlowError, writeAtomic } from './util.mjs';
import { workspaceRegistryFile } from './workspace-context.mjs';

const OWNED_PREFIXES = Object.freeze([
  'sflow-state-classifier-',
  'sflow-configuration-classifier-',
  'sflow-onboarding-legacy-proof-',
  'sflow-onboarding-recreate-preview-',
  'sflow-onboarding-source-',
  'sflow-onboarding-history-',
  'sflow-onboarding-proposal-',
  'sflow-onboarding-configuration-',
  'sflow-onboarding-candidate-',
  'sflow-lead-map-'
]);
const RECORD_NAME = /^[0-9a-f]{64}\.json$/u;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_QUEUE_RECORDS = 128;
const DEFAULT_SWEEP_LIMIT = 4;
const SWEEP_DEADLINE_MS = 250;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function portablePathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function containedPath(boundary, target) {
  const relative = path.relative(boundary, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function ownedBasename(value) {
  return OWNED_PREFIXES.some((prefix) => value.startsWith(prefix)
    && /^[A-Za-z0-9_-]{6}$/u.test(value.slice(prefix.length)));
}

function recordName(directory) {
  return `${createHash('sha256').update(path.resolve(directory)).digest('hex')}.json`;
}

export function repositoryOnboardingCleanupQueueRoot({
  env = process.env,
  home = os.homedir(),
  root = null
} = {}) {
  return path.resolve(root
    || path.join(path.dirname(workspaceRegistryFile(env, home)),
      'repository-onboarding-cleanup-v1'));
}

export function repositoryOnboardingCleanupContention(error) {
  if (error?.code === 'EBUSY' || error?.code === 'ENOTEMPTY') return true;
  return process.platform === 'win32' && (error?.code === 'EACCES' || error?.code === 'EPERM');
}

async function ordinaryDirectory(target) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) return 'unsafe';
    return 'directory';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

async function ownedTemporaryDirectory(target) {
  const resolved = path.resolve(String(target ?? ''));
  if (!ownedBasename(path.basename(resolved))) return { status: 'unsafe', path: resolved };
  let temporaryRoot;
  let parent;
  try {
    [temporaryRoot, parent] = await Promise.all([
      realpath(os.tmpdir()),
      realpath(path.dirname(resolved))
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { status: 'missing', path: resolved };
    }
    throw error;
  }
  if (portablePathKey(temporaryRoot) !== portablePathKey(parent)) {
    return { status: 'unsafe', path: resolved };
  }
  return { status: await ordinaryDirectory(resolved), path: resolved };
}

async function createOrdinaryDirectory(target, message) {
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    // Two VS Code windows may encounter the first deferred cleanup at the same time. Creation is
    // deliberately idempotent, but the winner's entry is always revalidated below before use.
    if (error?.code !== 'EEXIST') throw error;
  }
  if (await ordinaryDirectory(target) !== 'directory') {
    throw new SingularityFlowError(message, {
      code: 'REPOSITORY_ONBOARDING_CLEANUP_STORAGE_UNSAFE'
    });
  }
}

function queueStorageBoundary(target, home) {
  const resolved = path.resolve(target);
  // A user's home and the operating-system temp directory are pre-existing machine boundaries.
  // Walking below either lets macOS keep its harmless `/var` -> `/private/var` alias while still
  // refusing any queue-specific symlink introduced below the trusted boundary.
  const candidates = [path.resolve(home), path.resolve(os.tmpdir())]
    .filter((candidate) => containedPath(candidate, resolved))
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? path.parse(resolved).root;
}

async function validateQueueDirectoryTree(target, { home, create = false } = {}) {
  const resolved = path.resolve(target);
  const boundary = queueStorageBoundary(resolved, home);
  if (await ordinaryDirectory(boundary) !== 'directory') {
    throw new SingularityFlowError(
      'Repository-onboarding cleanup storage has an unsafe parent.', {
        code: 'REPOSITORY_ONBOARDING_CLEANUP_STORAGE_UNSAFE'
      }
    );
  }
  const relative = path.relative(boundary, resolved);
  let cursor = boundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const state = await ordinaryDirectory(cursor);
    if (state === 'unsafe' || (state === 'missing' && !create)) {
      throw new SingularityFlowError(
        'Repository-onboarding cleanup storage has an unsafe parent.', {
          code: 'REPOSITORY_ONBOARDING_CLEANUP_STORAGE_UNSAFE'
        }
      );
    }
    if (state === 'missing') {
      await createOrdinaryDirectory(
        cursor, 'Repository-onboarding cleanup storage has an unsafe parent.'
      );
    }
  }
  // Rebind the complete path to the trusted boundary after the component walk. This detects an
  // ancestor exchanged for a symlink between lstat calls without treating the trusted macOS temp
  // alias itself as queue-controlled storage.
  const [canonicalBoundary, canonicalTarget] = await Promise.all([
    realpath(boundary), realpath(resolved)
  ]);
  const expected = path.resolve(canonicalBoundary, relative);
  if (portablePathKey(canonicalTarget) !== portablePathKey(expected)) {
    throw new SingularityFlowError(
      'Repository-onboarding cleanup storage has an unsafe parent.', {
        code: 'REPOSITORY_ONBOARDING_CLEANUP_STORAGE_UNSAFE'
      }
    );
  }
}

async function privateQueueParent(root, { home }) {
  const parent = path.dirname(root);
  await validateQueueDirectoryTree(parent, { home, create: true });
}

async function privateQueueDirectory(root, { home }) {
  const state = await ordinaryDirectory(root);
  if (state === 'unsafe') throw new SingularityFlowError(
    'Repository-onboarding cleanup storage is not an ordinary directory.', {
      code: 'REPOSITORY_ONBOARDING_CLEANUP_STORAGE_UNSAFE'
    }
  );
  if (state === 'missing') {
    await createOrdinaryDirectory(
      root, 'Repository-onboarding cleanup storage is unavailable.'
    );
  }
  // Tighten an existing directory as well as a newly-created one. chmod is advisory on Windows;
  // access control there remains the owning user's profile ACL.
  await chmod(root, 0o700).catch(() => {});
  if (await ordinaryDirectory(root) !== 'directory') throw new SingularityFlowError(
    'Repository-onboarding cleanup storage is unavailable.', {
      code: 'REPOSITORY_ONBOARDING_CLEANUP_STORAGE_UNSAFE'
    }
  );
  await validateQueueDirectoryTree(root, { home });
}

async function discardRecord(file) {
  try {
    await rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function parseRecord(bytes, file) {
  if (bytes.length > MAX_RECORD_BYTES) return { status: 'invalid', record: null };
  try {
    const value = readRecord('repository-onboarding-cleanup', bytes).record;
    if (typeof value.path !== 'string'
        || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
        || (value.attempts != null && (!Number.isSafeInteger(value.attempts) || value.attempts < 0))
        || (value.nextAttemptAt != null
          && (typeof value.nextAttemptAt !== 'string'
            || !Number.isFinite(Date.parse(value.nextAttemptAt))))
        || recordName(value.path) !== path.basename(file)) {
      return { status: 'invalid', record: null };
    }
    return { status: 'ready', record: value };
  } catch (error) {
    // An older binary must never erase a record written by a newer binary. Its target remains
    // untouched and the entry continues to count toward the bounded local backlog until upgrade.
    if (error?.code === 'SCHEMA_VERSION_FUTURE'
        || error?.code === 'SCHEMA_VERSION_ARCHIVED') {
      return { status: 'preserved', record: null };
    }
    return { status: 'invalid', record: null };
  }
}

function queuePayload(target, values = {}) {
  return `${JSON.stringify({
    schemaVersion: currentSchemaVersion('repository-onboarding-cleanup'),
    path: target,
    createdAt: values.createdAt ?? new Date().toISOString(),
    attempts: values.attempts ?? 0,
    nextAttemptAt: values.nextAttemptAt ?? null
  }, null, 2)}\n`;
}

async function withQueueLease(queueRoot, operation, { home }) {
  await privateQueueParent(queueRoot, { home });
  const { withRegistryFileLease } = await import('./workspace.mjs');
  // The lease is the directory's sibling `<root>.lock`, so machine-state reset can acquire the
  // same fence before staging the local state root. No queue file has to exist to take the lease.
  return withRegistryFileLease(queueRoot, operation);
}

/** Queue one exact SFlow-owned temp directory. Invalid, missing, or foreign paths are refused. */
export async function enqueueRepositoryOnboardingCleanup(directory, {
  env = process.env,
  home = os.homedir(),
  root = null
} = {}) {
  const proof = await ownedTemporaryDirectory(directory);
  if (proof.status !== 'directory') return false;
  const queueRoot = repositoryOnboardingCleanupQueueRoot({ env, home, root });
  return withQueueLease(queueRoot, async () => {
    await privateQueueDirectory(queueRoot, { home });
    const file = path.join(queueRoot, recordName(proof.path));
    // Parse the queue before enforcing its cap. Invalid regular records are discarded. Records
    // from a future schema remain counted and untouched until a compatible binary can read them.
    await queueCandidates(queueRoot);
    const names = await queueRecordNames(queueRoot);
    if (names.includes(path.basename(file))) {
      const info = await lstat(file).catch(() => null);
      const existing = info?.isFile() && !info.isSymbolicLink()
        && info.size <= MAX_RECORD_BYTES
        ? parseRecord(await readFile(file), file) : { status: 'invalid' };
      // A record already binds this target hash. Preserve both a current retry schedule and bytes
      // written by a newer schema instead of resetting or downgrading either one.
      if (existing.status === 'ready' || existing.status === 'preserved') return true;
    }
    if (!names.includes(path.basename(file)) && names.length >= MAX_QUEUE_RECORDS) {
      throw new SingularityFlowError(
        'Repository-onboarding cleanup backlog is full. Close processes using prior temporary snapshots and retry.', {
          code: 'REPOSITORY_ONBOARDING_CLEANUP_BACKLOG_FULL',
          details: { maximumEntries: MAX_QUEUE_RECORDS }
        }
      );
    }
    // Atomic rename replaces a corrupt regular file or symlink as a directory entry; it never
    // chmods or opens the symlink target.
    await writeAtomic(file, queuePayload(proof.path), { mode: 0o600 });
    const published = await lstat(file);
    const parsed = published.isSymbolicLink() || !published.isFile()
      || published.size > MAX_RECORD_BYTES
      ? { status: 'invalid' } : parseRecord(await readFile(file), file);
    if (parsed.status !== 'ready') {
      throw new SingularityFlowError('Repository-onboarding cleanup record could not be verified.', {
        code: 'REPOSITORY_ONBOARDING_CLEANUP_RECORD_INVALID'
      });
    }
    return true;
  }, { home });
}

async function queueRecordNames(root) {
  return (await readdir(root)).filter((entry) => RECORD_NAME.test(entry));
}

async function queueCandidates(root) {
  const candidates = [];
  for (const name of (await readdir(root)).filter((entry) => RECORD_NAME.test(entry))) {
    const file = path.join(root, name);
    const info = await lstat(file).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile()) {
      await discardRecord(file);
      continue;
    }
    if (info.size > MAX_RECORD_BYTES) {
      await discardRecord(file);
      continue;
    }
    let parsed;
    try { parsed = parseRecord(await readFile(file), file); }
    catch { continue; }
    if (parsed.status === 'preserved') continue;
    if (parsed.status !== 'ready') {
      await discardRecord(file);
      continue;
    }
    candidates.push({ file, info, record: parsed.record });
  }
  return candidates.sort((left, right) => left.info.mtimeMs - right.info.mtimeMs
    || left.file.localeCompare(right.file));
}

function nextAttempt(attempts, now) {
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(attempts, 12)));
  return new Date(now + delay).toISOString();
}

/**
 * Retry a bounded rotating set of previously queued snapshots.
 *
 * Invalid records are discarded, but their named targets are never touched. A legitimate target
 * is removed only after its parent, basename, type, and record digest have all been revalidated.
 * Deferred retries use one filesystem attempt and exponential backoff, so stale locks cannot make
 * repository inspection wait through the foreground Windows retry budget.
 */
export async function drainRepositoryOnboardingCleanup({
  env = process.env,
  home = os.homedir(),
  root = null,
  limit = DEFAULT_SWEEP_LIMIT,
  deadlineMs = SWEEP_DEADLINE_MS
} = {}) {
  const queueRoot = repositoryOnboardingCleanupQueueRoot({ env, home, root });
  const initialState = await ordinaryDirectory(queueRoot);
  if (initialState === 'unsafe') {
    throw new SingularityFlowError(
      'Repository-onboarding cleanup storage is not an ordinary directory.', {
        code: 'REPOSITORY_ONBOARDING_CLEANUP_STORAGE_UNSAFE'
      }
    );
  }
  if (initialState === 'missing') {
    return Object.freeze({ processed: 0, removed: 0, retained: 0, failed: 0 });
  }
  return withQueueLease(queueRoot, async () => {
    // Reset may have staged the queue between the optimistic existence check and lease acquisition.
    // Do not recreate it during a read-only drain.
    const leasedState = await ordinaryDirectory(queueRoot);
    if (leasedState === 'unsafe') {
      throw new SingularityFlowError(
        'Repository-onboarding cleanup storage is not an ordinary directory.', {
          code: 'REPOSITORY_ONBOARDING_CLEANUP_STORAGE_UNSAFE'
        }
      );
    }
    if (leasedState === 'missing') {
      return Object.freeze({ processed: 0, removed: 0, retained: 0, failed: 0 });
    }
    await privateQueueDirectory(queueRoot, { home });
    const candidates = await queueCandidates(queueRoot);
    const started = Date.now();
    const requestedLimit = Number(limit);
    const maximum = Number.isFinite(requestedLimit)
      ? Math.max(0, Math.min(32, Math.trunc(requestedLimit))) : DEFAULT_SWEEP_LIMIT;
    const requestedDeadline = Number(deadlineMs);
    const deadline = Number.isFinite(requestedDeadline)
      ? Math.max(0, Math.trunc(requestedDeadline)) : SWEEP_DEADLINE_MS;
    let processed = 0;
    let removed = 0;
    let failed = 0;
    for (const candidate of candidates) {
      if (processed >= maximum || Date.now() - started >= deadline) break;
      const eligibleAt = candidate.record.nextAttemptAt == null
        ? 0 : Date.parse(candidate.record.nextAttemptAt);
      if (eligibleAt > Date.now()) continue;
      processed += 1;
      let proof;
      try { proof = await ownedTemporaryDirectory(candidate.record.path); }
      catch {
        failed += 1;
        continue;
      }
      if (proof.status !== 'directory') {
        if (!await discardRecord(candidate.file)) failed += 1;
        continue;
      }
      try {
        await removeTemporaryTree(proof.path, {
          attempts: 1, maxRetries: 0, retryDelay: 0, outerRetryDelay: 0
        });
        removed += 1;
        if (!await discardRecord(candidate.file)) failed += 1;
      } catch (error) {
        if (!repositoryOnboardingCleanupContention(error)) {
          failed += 1;
          continue;
        }
        const attempts = Math.min(Number.MAX_SAFE_INTEGER,
          Number(candidate.record.attempts ?? 0) + 1);
        try {
          await writeAtomic(candidate.file, queuePayload(proof.path, {
            createdAt: candidate.record.createdAt,
            attempts,
            nextAttemptAt: nextAttempt(attempts, Date.now())
          }), { mode: 0o600 });
        } catch {
          failed += 1;
        }
      }
    }
    // Count the actual remaining pathnames after every best-effort delete/write. This includes a
    // future-schema record or a record whose deletion failed, so UI backlog accounting never says
    // zero while local recovery work is still present.
    const retained = (await queueRecordNames(queueRoot)).length;
    return Object.freeze({ processed, removed, retained, failed });
  }, { home });
}
