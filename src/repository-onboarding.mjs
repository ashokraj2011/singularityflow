/**
 * Repository-first capability onboarding.
 *
 * The public contract deliberately talks about one repository setup rather than exposing the
 * configuration/state authority implementation. Inspection is read-only and returns a content-
 * addressed plan. Application re-observes only the refs named by that plan immediately before its
 * first mutation; every remote write is then protected by an exact Git lease.
 */
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile
} from 'node:fs/promises';
import YAML from 'yaml';

import {
  CONFIGURATION_BRANCH, STATE_CONFIGURATION_FORMAT,
  STATE_CONFIGURATION_MANIFEST, configurationAssetPaths, configurationAssetPolicyFromRef,
  configurationTreeEntries, isConfigurationAsset, legacyStateMirrorMatchesRepository,
  stateConfigurationHistoryBranch
} from './configuration-branch.mjs';
import { DEFAULT_CONFIGURATION_ASSET_POLICY } from './configuration-assets.mjs';
import { initializeDefinition, loadDefinition } from './config.mjs';
import {
  CAPABILITY_AUTHORITY_LINK_PATH, validateCapabilityAuthorityLink
} from './capability-authority-link.mjs';
import {
  assertCredentialFreeRemote, configuredRemoteIdentity, frozenRemoteTransport,
  isPortableAbsoluteGitPath,
  remoteFingerprint, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import {
  gitCommitIdentityArgs, gitCommitIdentityEnvironment, gitCommitSigningArgs,
  preflightGitCommitIdentity, resolveGitCommitIdentity, resolveGitCommitSigning
} from './git.mjs';
import {
  gitRepositoryComparisonKey, sameGitRepository
} from './git-repository-identity.mjs';
import { GitRemoteSession, runRemoteGitAsync } from './git-execution.mjs';
import {
  forgetLeadRepository, listLeadRepositoryRegistryRecords, rememberLeadRepository
} from './lead-repositories.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import {
  drainRepositoryOnboardingCleanup, enqueueRepositoryOnboardingCleanup,
  repositoryOnboardingCleanupContention, repositoryOnboardingCleanupQueueRoot
} from './repository-onboarding-cleanup.mjs';
import { renderPlatformCommand } from './safe-command-guidance.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import {
  isGitRefName, removeTemporaryTree, run, SingularityFlowError
} from './util.mjs';

export const REPOSITORY_ONBOARDING_PLAN_KIND = 'repository-onboarding-plan/v1';
export const REPOSITORY_ONBOARDING_RESULT_KIND = 'repository-onboarding-result/v1';
export const REPOSITORY_ONBOARDING_MODES = Object.freeze([
  'auto', 'migrate', 'recreate', 'reset-local'
]);
export const REPOSITORY_STATE_KINDS = Object.freeze([
  'configuration-mirror', 'delivery-locator', 'lifecycle-only', 'none', 'invalid'
]);

const CURRENT_WORKFLOW_FORMAT_VERSION = 2;
const STATE_BRANCH_DEFAULT = 'state';
const CONFIGURATION_REF = `refs/heads/${CONFIGURATION_BRANCH}`;
const CONFIGURATION_RECOVERY_RECEIPT = 'singularity/.product/configuration-recovery.json';
const LEDGER_HEAD_PATH = 'ledger/head.json';
const ONBOARDING_REVIEW_PREFIX = 'sflow/config-change/onboarding/';
const STATE_MARKER_MAX_BYTES = 256 * 1024;
const STATE_MIRROR_MAX_FILES = 512;
const STATE_MIRROR_MAX_PATH_BYTES = 64 * 1024;
const STATE_MIRROR_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MAX_FILES = 16 * 1024;
const SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024;
const SNAPSHOT_TREE_LIST_MAX_BYTES = 16 * 1024 * 1024;
const TEMPORARY_CLEANUP_WARNING =
  'Repository inspection completed, but another process still has its disposable snapshot open. '
  + 'The onboarding decision is valid; SFlow queued cleanup and will retry after the locking process exits.';
const TEMPORARY_CLEANUP_UNQUEUED_WARNING =
  'Repository inspection completed, but another process still has its disposable snapshot open. '
  + 'The onboarding decision is valid; local recovery storage was unavailable, so cleanup could not be queued.';
const TEMPORARY_CLEANUP_BACKLOG_WARNING =
  'Previous repository-inspection cleanup is still pending; '
  + 'SFlow will retry that machine-local cleanup without changing repository authority.';
const TEMPORARY_CLEANUP_STORAGE_WARNING =
  'Machine-local repository cleanup storage could not be inspected. '
  + 'SFlow continued without deleting or trusting that storage.';
const TEMPORARY_MUTATION_CLEANUP_WARNING =
  'Repository setup completed, but another process still has its disposable checkout open. '
  + 'The governed result is preserved; SFlow queued cleanup and will retry after the locking process exits.';
const TEMPORARY_MUTATION_CLEANUP_UNQUEUED_WARNING =
  'Repository setup completed, but SFlow could not remove its disposable checkout. '
  + 'The governed result is preserved; local cleanup could not be queued.';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function attachCleanupEvidence(primaryFailure, cleanupFailure) {
  if (!primaryFailure || typeof primaryFailure !== 'object'
      || !Object.isExtensible(primaryFailure)) return primaryFailure;
  try {
    const existing = primaryFailure.details && typeof primaryFailure.details === 'object'
      ? primaryFailure.details : {};
    primaryFailure.details = {
      ...existing,
      cleanup: Object.freeze({
        completed: false,
        code: String(cleanupFailure?.code ?? 'TEMPORARY_TREE_CLEANUP_FAILED')
      })
    };
  } catch {
    // Cleanup evidence is diagnostic only. A read-only/accessor-backed details property must
    // never replace the operation's original typed failure.
  }
  return primaryFailure;
}

/**
 * A disposable read checkout is not part of the governed decision. Once the read has completed,
 * an external Windows scanner retaining the directory must not replace that decision with EBUSY.
 * Likewise, cleanup can never hide the operation's original typed failure.
 */
async function withDisposableReadSnapshot(directory, operation, {
  cleanupWarnings = [], cleanupQueueRoot = null,
  preserveSuccessfulResult = false
} = {}) {
  let result;
  let primaryFailure = null;
  try {
    result = await operation();
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await removeTemporaryTree(directory);
  } catch (cleanupFailure) {
    if (primaryFailure) {
      if (repositoryOnboardingCleanupContention(cleanupFailure)) {
        await enqueueRepositoryOnboardingCleanup(directory, { root: cleanupQueueRoot })
          .catch(() => false);
      }
      throw attachCleanupEvidence(primaryFailure, cleanupFailure);
    }
    const contention = repositoryOnboardingCleanupContention(cleanupFailure);
    if (!contention && !preserveSuccessfulResult) throw cleanupFailure;
    let queued = false;
    if (contention) {
      try {
        queued = await enqueueRepositoryOnboardingCleanup(directory, { root: cleanupQueueRoot });
      } catch { /* Cleanup recovery is diagnostic and cannot replace a completed operation. */ }
    }
    const warning = preserveSuccessfulResult
      ? queued ? TEMPORARY_MUTATION_CLEANUP_WARNING : TEMPORARY_MUTATION_CLEANUP_UNQUEUED_WARNING
      : queued ? TEMPORARY_CLEANUP_WARNING : TEMPORARY_CLEANUP_UNQUEUED_WARNING;
    if (!cleanupWarnings.includes(warning)) {
      cleanupWarnings.push(warning);
    }
  }
  if (primaryFailure) throw primaryFailure;
  return result;
}

async function withDisposableMutationCheckout(directory, operation, context) {
  const result = await withDisposableReadSnapshot(directory, operation, {
    cleanupWarnings: context.cleanupWarnings,
    cleanupQueueRoot: context.cleanupQueueRoot,
    preserveSuccessfulResult: true
  });
  if (result?.kind !== REPOSITORY_ONBOARDING_RESULT_KIND) return result;
  return Object.freeze({
    ...result,
    localCleanupWarnings: Object.freeze([...(context.cleanupWarnings ?? [])])
  });
}

async function cleanupAfterFailure(directory, primaryFailure, cleanupQueueRoot = null) {
  try { await removeTemporaryTree(directory); }
  catch (cleanupFailure) {
    attachCleanupEvidence(primaryFailure, cleanupFailure);
    if (repositoryOnboardingCleanupContention(cleanupFailure)) {
      await enqueueRepositoryOnboardingCleanup(directory, { root: cleanupQueueRoot })
        .catch(() => false);
    }
  }
  throw primaryFailure;
}

function repositorySubjectIdentity(remote) {
  const key = gitRepositoryComparisonKey(remote);
  return key ? `sha256:${recordSha256({ repositoryKey: key })}` : null;
}

function exactCommit(value) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(String(value ?? ''));
}

function networkRepositoryLocator(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return true;
  // `C:repo.git` is a drive-relative path on Windows, not an SCP authority. Resolve it before a
  // temporary checkout changes cwd; on other platforms refuse the ambiguous spelling below.
  if (/^[A-Za-z]:[^\\/]/u.test(value)) return false;
  return /^(?:[^/\\:@]+@)?[^/\\:]+:.+/u.test(value);
}

function canonicalRepositoryLocator(value) {
  const input = assertCredentialFreeRemote(value);
  if (isPortableAbsoluteGitPath(input) || networkRepositoryLocator(input)) return input;
  if (/^[A-Za-z]:[^\\/]/u.test(input) && process.platform !== 'win32') {
    throw new SingularityFlowError(
      `Drive-relative repository path '${sanitizeRemote(input)}' is ambiguous on this platform. Use an absolute path.`, {
        code: 'REPOSITORY_ONBOARDING_RELATIVE_PATH_AMBIGUOUS'
      }
    );
  }
  return path.resolve(input);
}

function onboardingCommand(remote, {
  mode = 'auto', stateBranch = STATE_BRANCH_DEFAULT, planId = null
} = {}) {
  const argv = ['singularity-flow', 'capability', 'onboard', String(remote)];
  if (mode !== 'auto') argv.push(`--${mode}`);
  if (stateBranch !== STATE_BRANCH_DEFAULT) argv.push('--state-branch', stateBranch);
  argv.push(...(planId ? ['--confirm-plan', planId] : ['--dry-run']), '--json');
  return renderPlatformCommand(argv);
}

function stateBranchName(value) {
  const branch = String(value ?? STATE_BRANCH_DEFAULT).trim();
  if (!isGitRefName(branch) || branch.startsWith('refs/')) {
    throw new SingularityFlowError(`State branch '${branch}' is not a safe branch name.`, {
      code: 'REPOSITORY_ONBOARDING_STATE_BRANCH_INVALID'
    });
  }
  return branch;
}

function onboardingMode(value) {
  const mode = String(value ?? 'auto').trim() || 'auto';
  if (!REPOSITORY_ONBOARDING_MODES.includes(mode)) {
    throw new SingularityFlowError(
      `Repository onboarding mode must be one of: ${REPOSITORY_ONBOARDING_MODES.join(', ')}.`, {
        code: 'REPOSITORY_ONBOARDING_MODE_INVALID'
      }
    );
  }
  return mode;
}

function repositoryBinding(repository, requestedRepository) {
  return Object.freeze({
    url: sanitizeRemote(repository),
    identity: `sha256:${remoteFingerprint(repository)}`,
    inputIdentity: `sha256:${remoteFingerprint(requestedRepository)}`
  });
}

async function repositoryInputRemote(value, env = process.env) {
  const input = canonicalRepositoryLocator(value);
  let info = await lstat(input).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info) return input;
  let repositoryPath = input;
  if (info.isSymbolicLink()) {
    try {
      repositoryPath = await realpath(input);
      info = await lstat(repositoryPath);
    } catch (error) {
      if (info.isSymbolicLink()) {
        throw new SingularityFlowError(
          'The selected repository link is broken or cannot be resolved. Choose the repository again.', {
            code: 'REPOSITORY_ONBOARDING_CLONE_LINK_INVALID',
            details: { causeCode: error?.code ?? null }
          }
        );
      }
      throw error;
    }
  }
  if (!info.isDirectory()) return input;
  const worktree = run('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repositoryPath, env, allowFailure: true
  });
  if (worktree.status !== 0 || worktree.stdout.trim() !== 'true') return repositoryPath;
  const fetch = configuredRemoteIdentity(repositoryPath, 'origin', { direction: 'fetch', env });
  const push = configuredRemoteIdentity(repositoryPath, 'origin', { direction: 'push', env });
  if (!fetch.configured || fetch.ambiguous || !fetch.url
      || !push.configured || push.ambiguous || !push.url) {
    throw new SingularityFlowError(
      'The repository checkout must have one unambiguous origin URL before setup can continue.', {
        code: 'REPOSITORY_ONBOARDING_CLONE_ORIGIN_AMBIGUOUS'
      }
    );
  }
  const absoluteLocal = (remote) => {
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[^/\\]+@[^:]+:)/iu.test(remote)
        || path.isAbsolute(remote)) return remote;
    return path.resolve(repositoryPath, remote);
  };
  const fetchUrl = assertCredentialFreeRemote(absoluteLocal(fetch.url));
  const pushUrl = assertCredentialFreeRemote(absoluteLocal(push.url));
  if (fetchUrl !== pushUrl) {
    throw new SingularityFlowError(
      'The repository checkout uses different origin fetch and push authorities. Supply the reviewed repository URL explicitly.', {
        code: 'REPOSITORY_ONBOARDING_CLONE_AUTHORITY_AMBIGUOUS'
      }
    );
  }
  return fetchUrl;
}

async function regularFile(root, relative) {
  const file = path.join(root, ...relative.split('/'));
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`State marker '${relative}' must be a regular file.`, {
      code: 'REPOSITORY_STATE_MARKER_INVALID'
    });
  }
  return file;
}

async function readOptionalFile(root, relative) {
  const file = await regularFile(root, relative);
  return file ? readFile(file) : null;
}

function refBlob(root, relative, env) {
  const exists = run('git', ['cat-file', '-e', `HEAD:${relative}`], {
    cwd: root, env, allowFailure: true, timeoutClass: 'local-read'
  });
  if (exists.status !== 0) return null;
  const shown = run('git', ['show', `HEAD:${relative}`], {
    cwd: root, env, encoding: 'buffer', maxBuffer: STATE_MARKER_MAX_BYTES,
    timeoutClass: 'local-read'
  });
  return Buffer.from(shown.stdout);
}

function boundedMirrorPaths(manifest) {
  const files = manifest?.files;
  const assets = manifest?.assets;
  if (!files || typeof files !== 'object' || Array.isArray(files)
      || !assets || typeof assets !== 'object' || Array.isArray(assets)) {
    throw new SingularityFlowError('State configuration manifest has no bounded asset map.', {
      code: 'STATE_CONFIGURATION_MIRROR_INVALID'
    });
  }
  const declared = Object.keys(files).sort();
  const pathBytes = declared.reduce((total, relative) =>
    total + Buffer.byteLength(relative, 'utf8'), 0);
  if (!declared.length || declared.length > STATE_MIRROR_MAX_FILES
      || pathBytes > STATE_MIRROR_MAX_PATH_BYTES
      || declared.some((relative) => !relative || relative.length > 1024
        || relative.includes('\\') || /[\0\r\n*?\[\]]/u.test(relative)
        || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative
        || relative.split('/').includes('..'))
      || JSON.stringify(Object.keys(assets).sort()) !== JSON.stringify(declared)) {
    throw new SingularityFlowError('State configuration manifest exceeds its safe file/path limits.', {
      code: 'STATE_CONFIGURATION_MIRROR_LIMIT_EXCEEDED'
    });
  }
  return declared;
}

async function materializeBoundedMirror(root, manifest, env) {
  const declared = boundedMirrorPaths(manifest);
  const selected = [STATE_CONFIGURATION_MANIFEST, ...declared];
  const entries = new Map();
  // Keep argv well below the conservative Windows command-line ceiling. Each pathspec is literal,
  // so a reviewed manifest cannot expand one declared filename into an unbounded checkout.
  let batch = [];
  let batchBytes = 0;
  const flush = () => {
    if (!batch.length) return;
    const listed = run('git', [
      'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', 'HEAD', '--',
      ...batch.map((relative) => `:(literal)${relative}`)
    ], { cwd: root, env, maxBuffer: 2 * 1024 * 1024, timeoutClass: 'local-read' });
    for (const line of listed.stdout.split('\0').filter(Boolean)) {
      const first = line.indexOf(' ');
      const second = line.indexOf(' ', first + 1);
      const mode = line.slice(0, first);
      const object = line.slice(first + 1, second);
      const relative = line.slice(second + 1);
      if (!/^100(?:644|755)$/u.test(mode) || !exactCommit(object)
          || !selected.includes(relative) || entries.has(relative)) {
        throw new SingularityFlowError('State configuration mirror contains an unsafe asset identity.', {
          code: 'STATE_CONFIGURATION_MIRROR_INVALID'
        });
      }
      entries.set(relative, { mode, object });
    }
    batch = [];
    batchBytes = 0;
  };
  for (const relative of selected) {
    const bytes = Buffer.byteLength(relative, 'utf8') + 12;
    if (batch.length >= 64 || batchBytes + bytes > 8 * 1024) flush();
    batch.push(relative);
    batchBytes += bytes;
  }
  flush();
  if (entries.size !== selected.length || selected.some((relative) => !entries.has(relative))) {
    throw new SingularityFlowError('State configuration manifest names missing assets.', {
      code: 'STATE_CONFIGURATION_MIRROR_INVALID'
    });
  }
  const ordered = selected.map((relative) => ({ relative, ...entries.get(relative) }));
  const objects = ordered.map((entry) => entry.object);
  const payload = run('git', [
    'cat-file', '--batch'
  ], {
    cwd: root, env, encoding: 'buffer', input: `${objects.join('\n')}\n`,
    maxBuffer: STATE_MIRROR_MAX_ASSET_BYTES + STATE_MARKER_MAX_BYTES + 2 * 1024 * 1024,
    timeoutClass: 'local-read'
  }).stdout;
  let cursor = 0;
  let totalBytes = 0;
  for (const entry of ordered) {
    const newline = payload.indexOf(0x0a, cursor);
    const header = newline >= 0
      ? payload.toString('utf8', cursor, newline).trim().split(' ') : [];
    const size = Number(header[2]);
    const limit = entry.relative === STATE_CONFIGURATION_MANIFEST
      ? STATE_MARKER_MAX_BYTES : STATE_MIRROR_MAX_ASSET_BYTES;
    if (header[0] !== entry.object || header[1] !== 'blob'
        || !Number.isSafeInteger(size) || size < 0 || size > limit) {
      throw new SingularityFlowError('State configuration mirror exceeds its safe payload limit.', {
        code: 'STATE_CONFIGURATION_MIRROR_LIMIT_EXCEEDED'
      });
    }
    if (entry.relative !== STATE_CONFIGURATION_MANIFEST) totalBytes += size;
    const start = newline + 1;
    const end = start + size;
    if (newline < 0 || end > payload.length || totalBytes > STATE_MIRROR_MAX_ASSET_BYTES) {
      throw new SingularityFlowError('State configuration mirror exceeds its safe payload limit.', {
        code: 'STATE_CONFIGURATION_MIRROR_LIMIT_EXCEEDED'
      });
    }
    const destination = path.join(root, ...entry.relative.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, payload.subarray(start, end));
    await chmod(destination, entry.mode === '100755' ? 0o755 : 0o644);
    cursor = end + 1;
  }
  return declared;
}

function assertSnapshotQuotaValues(files, bytes) {
  if (files > SNAPSHOT_MAX_FILES || bytes > SNAPSHOT_MAX_BYTES) {
    throw new SingularityFlowError(
      'Repository setup snapshot exceeds its safe local file or byte limit.', {
        code: 'REPOSITORY_ONBOARDING_SNAPSHOT_LIMIT_EXCEEDED',
        details: {
          files, bytes, maximumFiles: SNAPSHOT_MAX_FILES, maximumBytes: SNAPSHOT_MAX_BYTES
        }
      }
    );
  }
}

async function assertSnapshotQuota(root, {
  additionalFiles = 0, additionalBytes = 0
} = {}) {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      files += 1;
      if (entry.isFile()) bytes += (await lstat(target)).size;
      assertSnapshotQuotaValues(files + additionalFiles, bytes + additionalBytes);
    }
  }
  assertSnapshotQuotaValues(files + additionalFiles, bytes + additionalBytes);
  return { files, bytes };
}

function snapshotTreeQuota(root, env) {
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--full-tree', '--long', 'HEAD'
  ], {
    cwd: root, env, allowFailure: true, encoding: 'buffer',
    maxBuffer: SNAPSHOT_TREE_LIST_MAX_BYTES, timeoutClass: 'local-read'
  });
  if (listed.status !== 0 || listed.error || listed.timedOut || listed.signal != null) {
    if (listed.error?.code === 'ENOBUFS') {
      throw new SingularityFlowError(
        'Repository setup snapshot exceeds its bounded tree-listing limit.', {
          code: 'REPOSITORY_ONBOARDING_SNAPSHOT_LIMIT_EXCEEDED',
          details: {
            maximumFiles: SNAPSHOT_MAX_FILES, maximumBytes: SNAPSHOT_MAX_BYTES,
            maximumListingBytes: SNAPSHOT_TREE_LIST_MAX_BYTES
          }
        }
      );
    }
    throw new SingularityFlowError(
      'Repository setup snapshot tree could not be inspected before checkout.', {
        code: 'REPOSITORY_ONBOARDING_SNAPSHOT_UNAVAILABLE'
      }
    );
  }
  const payload = Buffer.from(listed.stdout);
  let files = 0;
  let bytes = 0;
  let cursor = 0;
  while (cursor < payload.length) {
    const end = payload.indexOf(0, cursor);
    if (end < 0) {
      throw new SingularityFlowError(
        'Repository setup snapshot tree contains an incomplete entry.', {
          code: 'REPOSITORY_ONBOARDING_SNAPSHOT_UNAVAILABLE'
        }
      );
    }
    const record = payload.subarray(cursor, end);
    const tab = record.indexOf(0x09);
    const header = tab < 0 ? '' : record.subarray(0, tab).toString('ascii');
    const match = /^(?:100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+|-)$/u.exec(header);
    if (!match || tab === record.length - 1) {
      throw new SingularityFlowError(
        'Repository setup snapshot tree contains an unsupported entry.', {
          code: 'REPOSITORY_ONBOARDING_SNAPSHOT_UNAVAILABLE'
        }
      );
    }
    const size = match[3] === '-' ? 0 : Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new SingularityFlowError(
        'Repository setup snapshot tree contains an invalid object size.', {
          code: 'REPOSITORY_ONBOARDING_SNAPSHOT_UNAVAILABLE'
        }
      );
    }
    files += 1;
    bytes += size;
    assertSnapshotQuotaValues(files, bytes);
    cursor = end + 1;
  }
  return { files, bytes };
}

function publicFailure(failure) {
  if (!failure || typeof failure !== 'object') return null;
  return Object.freeze({
    code: failure.code ?? 'REMOTE_UNKNOWN',
    classification: failure.classification ?? 'unknown',
    retryable: failure.retryable === true,
    advice: failure.advice ?? 'Inspect Git access and retry.'
  });
}

async function cloneObservedBranch(remote, branch, expectedCommit, {
  env, runRemoteCommand = runRemoteGitAsync, prefix = 'sflow-repository-onboarding-',
  checkout = true, cleanupQueueRoot = null
}) {
  const queueRoot = repositoryOnboardingCleanupQueueRoot({ env, root: cleanupQueueRoot });
  const scratch = await mkdtemp(path.join(os.tmpdir(), prefix));
  const transport = frozenRemoteTransport(remote, { env });
  const cloned = await runRemoteCommand([
    '-c', 'core.autocrlf=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    'clone', '--quiet', '--no-local', '--no-tags',
    '--single-branch', '--depth', '1', '--filter=blob:none',
    '--no-checkout',
    '--branch', branch, transport.remote, scratch
  ], { cwd: path.dirname(scratch), operation: 'remote-configuration', env: transport.env });
  if (cloned.status !== 0) {
    return cleanupAfterFailure(scratch, new SingularityFlowError(
      `Could not read repository setup from '${sanitizeRemote(remote)}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`, {
        code: cloned.failure?.code ?? 'REPOSITORY_ONBOARDING_SNAPSHOT_UNAVAILABLE',
        details: { failure: publicFailure(cloned.failure), branch }
      }
    ), queueRoot);
  }
  let localQuota;
  try {
    // Servers may ignore partial-clone filtering. Enforce an object-store ceiling before inspecting
    // the tree, then admit the complete tracked tree before any worktree path is materialized.
    localQuota = await assertSnapshotQuota(scratch);
  } catch (error) {
    return cleanupAfterFailure(scratch, error, queueRoot);
  }
  const commit = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: scratch, env: transport.env, allowFailure: true
  }).stdout.trim();
  if (commit !== expectedCommit) {
    return cleanupAfterFailure(scratch, new SingularityFlowError(
      `Repository setup branch '${branch}' changed while it was being inspected. Refresh and retry; nothing was changed.`, {
        code: 'REPOSITORY_ONBOARDING_OBSERVATION_CHANGED',
        details: { branch, expectedCommit, actualCommit: commit || null }
      }
    ), queueRoot);
  }
  if (checkout) {
    try {
      const treeQuota = snapshotTreeQuota(scratch, transport.env);
      assertSnapshotQuotaValues(
        localQuota.files + treeQuota.files,
        localQuota.bytes + treeQuota.bytes
      );
      run('git', ['checkout', '--quiet', '--force', '--detach', commit], {
        cwd: scratch, env: transport.env, timeoutClass: 'local-read'
      });
      await assertSnapshotQuota(scratch);
    } catch (error) {
      return cleanupAfterFailure(scratch, error, queueRoot);
    }
  }
  return { scratch, commit, env: transport.env };
}

function parseJson(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch (error) {
    throw new SingularityFlowError(`${label} is not valid JSON: ${error.message}`, {
      code: 'REPOSITORY_STATE_MARKER_INVALID'
    });
  }
}

function parseYaml(bytes, label) {
  try { return YAML.parse(Buffer.from(bytes).toString('utf8')) ?? {}; }
  catch (error) {
    throw new SingularityFlowError(`${label} is not valid YAML: ${error.message}`, {
      code: 'REPOSITORY_STATE_MARKER_INVALID'
    });
  }
}

async function verifiedMirrorFromCheckout(root, remote, branch, commit, env, runRemoteCommand) {
  const manifestBytes = await readOptionalFile(root, STATE_CONFIGURATION_MANIFEST);
  if (!manifestBytes) return null;
  const manifest = parseJson(manifestBytes, 'State configuration manifest');
  if (manifest?.format !== STATE_CONFIGURATION_FORMAT
      || manifest?.layout !== 'canonical-paths'
      || manifest?.source?.branch !== CONFIGURATION_BRANCH
      || !exactCommit(manifest?.source?.commit)
      || !manifest?.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
      || !manifest?.assets || typeof manifest.assets !== 'object' || Array.isArray(manifest.assets)) {
    throw new SingularityFlowError(
      `State configuration manifest must be ${STATE_CONFIGURATION_FORMAT} with canonical files, Git identities, and an exact ${CONFIGURATION_BRANCH} source.`, {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      }
    );
  }
  const expectedSubject = repositorySubjectIdentity(remote);
  const declaredSubject = manifest?.subject?.repositoryIdentity ?? null;
  if (declaredSubject != null && (!expectedSubject || declaredSubject !== expectedSubject)) {
    throw new SingularityFlowError(
      'State configuration mirror belongs to another repository.', {
        code: 'STATE_CONFIGURATION_MIRROR_SUBJECT_MISMATCH'
      }
    );
  }
  const legacyRepositoryBound = declaredSubject == null
    && await legacyStateMirrorMatchesRepository(root, remote, { env, runRemoteCommand });
  const expectedHistory = stateConfigurationHistoryBranch(manifest.source.commit);
  if (manifest.history != null && (manifest.history?.branch !== expectedHistory
      || manifest.history?.commit !== manifest.source.commit)) {
    throw new SingularityFlowError(
      'State configuration manifest contains an invalid immutable history reference.', {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      }
    );
  }
  const policy = configurationAssetPolicyFromRef(root, 'HEAD', { env });
  const paths = await configurationAssetPaths(root, policy);
  const declared = Object.keys(manifest.files).sort();
  if (!declared.includes('singularity/workflow.yml')
      || JSON.stringify(paths) !== JSON.stringify(declared)
      || JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify(declared)) {
    throw new SingularityFlowError(
      'State configuration mirror files do not exactly match its manifest.', {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      }
    );
  }
  const entries = configurationTreeEntries(root, 'HEAD', policy, { env });
  for (const relative of declared) {
    const bytes = await readFile(path.join(root, ...relative.split('/')));
    const actual = entries.get(relative);
    const descriptor = manifest.assets[relative];
    const digest = sha256(bytes);
    if (manifest.files[relative] !== digest
        || descriptor?.sha256 !== digest
        || !exactCommit(descriptor?.object)
        || !/^100(?:644|755)$/u.test(String(descriptor?.mode ?? ''))
        || descriptor.object !== actual?.object || descriptor.mode !== actual?.mode) {
      throw new SingularityFlowError(
        `State configuration mirror identity does not match for '${relative}'.`, {
          code: 'STATE_CONFIGURATION_MIRROR_INVALID'
        }
      );
    }
  }
  const workflow = parseYaml(
    await readFile(path.join(root, 'singularity', 'workflow.yml')), 'Mirrored workflow'
  );
  if (stateBranchName(workflow?.ledger?.branch) !== branch) {
    throw new SingularityFlowError(
      'State configuration mirror declares a different state branch.', {
        code: 'STATE_CONFIGURATION_MIRROR_BRANCH_MISMATCH'
      }
    );
  }
  const workflowVersion = Number.isInteger(workflow?.version) ? workflow.version : null;
  let compatibility = 'invalid';
  let validationError = null;
  let seedChanges = [];
  if (workflowVersion > CURRENT_WORKFLOW_FORMAT_VERSION) compatibility = 'future';
  else if (workflowVersion === CURRENT_WORKFLOW_FORMAT_VERSION) {
    try {
      await loadDefinition(root);
      const before = new Map(Object.entries(manifest.files));
      const wrote = await initializeDefinition(root);
      await loadDefinition(root);
      const afterPaths = await configurationAssetPaths(root);
      const after = new Map();
      for (const relative of afterPaths) {
        after.set(relative, sha256(await readFile(path.join(root, ...relative.split('/')))));
      }
      const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter((relative) => before.get(relative) !== after.get(relative)).sort();
      seedChanges = [...new Set([...wrote, ...changed])].sort();
      compatibility = seedChanges.length ? 'migration-required' : 'current';
    } catch (error) {
      validationError = error?.message ?? String(error);
    }
  } else if (workflowVersion != null && workflowVersion > 0) compatibility = 'unsupported-old';
  return Object.freeze({
    kind: 'configuration-mirror', branch, commit,
    sourceCommit: manifest.source.commit,
    subjectBound: declaredSubject != null,
    repositoryBound: declaredSubject != null || legacyRepositoryBound,
    ...(legacyRepositoryBound ? {
      legacyBinding: Object.freeze({ method: 'retained-history-and-portfolio' })
    } : {}),
    history: manifest.history == null ? null : Object.freeze({ ...manifest.history }),
    schemaVersion: workflowVersion,
    stateProjectionEnabled: workflow?.ledger?.enabled === true,
    compatibility,
    validationError,
    seedChanges: Object.freeze(seedChanges),
    files: Object.freeze([...declared]),
    assets: Object.freeze(Object.fromEntries(declared.map((relative) => [relative,
      Object.freeze({
        sha256: manifest.assets[relative].sha256,
        object: manifest.assets[relative].object,
        mode: manifest.assets[relative].mode
      })
    ])))
  });
}

function validLedgerHead(value) {
  let record;
  try { record = readRecord('ledger-entry', value).record; }
  catch { return false; }
  return Number.isSafeInteger(record?.sequence) && record.sequence >= 0
    && (record.entryHash == null || /^[0-9a-f]{64}$/u.test(record.entryHash))
    && (record.previousHeadHash == null || /^[0-9a-f]{64}$/u.test(record.previousHeadHash))
    && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt));
}

async function classifyStateObjectStore(root, remote, branch, commit, env, runRemoteCommand) {
  const manifestBytes = refBlob(root, STATE_CONFIGURATION_MANIFEST, env);
  const locatorBytes = refBlob(root, CAPABILITY_AUTHORITY_LINK_PATH, env);
  if (manifestBytes && locatorBytes) {
    throw new SingularityFlowError(
      'State branch contains conflicting configuration-mirror and delivery-locator markers.', {
        code: 'REPOSITORY_STATE_MARKER_CONFLICT'
      }
    );
  }
  if (manifestBytes) {
    const manifest = parseJson(manifestBytes, 'State configuration manifest');
    await materializeBoundedMirror(root, manifest, env);
    return verifiedMirrorFromCheckout(root, remote, branch, commit, env, runRemoteCommand);
  }
  if (locatorBytes) {
    const link = validateCapabilityAuthorityLink(locatorBytes, remote);
    return Object.freeze({
      kind: 'delivery-locator', branch, commit,
      routing: Object.freeze({
        leadUrl: link.authority.remote,
        capabilityIds: Object.freeze([...link.subject.capabilityIds])
      })
    });
  }
  const ledgerBytes = refBlob(root, LEDGER_HEAD_PATH, env);
  if (ledgerBytes) {
    if (!validLedgerHead(ledgerBytes)) {
      throw new SingularityFlowError('State ledger head is not a valid SFlow lifecycle record.', {
        code: 'REPOSITORY_STATE_LIFECYCLE_INVALID'
      });
    }
    return Object.freeze({ kind: 'lifecycle-only', branch, commit });
  }
  return Object.freeze({
    kind: 'invalid', branch, commit,
    reason: 'The branch exists but contains no recognized SFlow marker.'
  });
}

/**
 * Classify the already-observed state ref without doing another ref advertisement.
 *
 * The snapshot is cloned exactly once and the classifier applies strict precedence: complete
 * mirror, subject-bound locator, valid lifecycle ledger, then unrecognized/invalid.
 */
export async function classifyRepositoryState(remote, {
  stateBranch = STATE_BRANCH_DEFAULT,
  observation,
  env = process.env,
  runRemoteCommand = runRemoteGitAsync,
  cleanupWarnings = null,
  cleanupQueueRoot = null
} = {}) {
  const repository = assertCredentialFreeRemote(remote);
  const queueRoot = repositoryOnboardingCleanupQueueRoot({ env, root: cleanupQueueRoot });
  const branch = stateBranchName(stateBranch);
  const ref = `refs/heads/${branch}`;
  if (!observation?.ok || !(observation.refs instanceof Map)) {
    throw new SingularityFlowError(
      'Repository state classification requires one successful bounded Git observation.', {
        code: 'REPOSITORY_ONBOARDING_OBSERVATION_REQUIRED'
      }
    );
  }
  const commit = observation.refs.get(ref) ?? null;
  if (!commit) return Object.freeze({ kind: 'none', branch, commit: null });
  const snapshot = await cloneObservedBranch(repository, branch, commit, {
    env, runRemoteCommand, prefix: 'sflow-state-classifier-', checkout: false,
    cleanupQueueRoot: queueRoot
  });
  const warnings = cleanupWarnings ?? [];
  const result = await withDisposableReadSnapshot(snapshot.scratch, async () => {
    try {
      return await classifyStateObjectStore(
        snapshot.scratch, repository, branch, commit, snapshot.env, runRemoteCommand
      );
    } catch (error) {
      return Object.freeze({
        kind: 'invalid', branch, commit,
        reason: error?.message ?? String(error),
        code: error?.code ?? 'REPOSITORY_STATE_MARKER_INVALID'
      });
    }
  }, { cleanupWarnings: warnings, cleanupQueueRoot: queueRoot });
  return cleanupWarnings == null && warnings.length
    ? Object.freeze({ ...result, localCleanupWarnings: Object.freeze([...warnings]) })
    : result;
}

async function inspectConfigurationSnapshot(remote, commit, {
  env, runRemoteCommand = runRemoteGitAsync, cleanupWarnings = [], cleanupQueueRoot = null
}) {
  const queueRoot = repositoryOnboardingCleanupQueueRoot({ env, root: cleanupQueueRoot });
  if (!commit) return Object.freeze({
    branch: CONFIGURATION_BRANCH, commit: null, status: 'missing',
    schemaVersion: null, currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
    stateBranch: null, stateProjectionEnabled: false,
    seedChanges: Object.freeze([]), validationError: null
  });
  const snapshot = await cloneObservedBranch(remote, CONFIGURATION_BRANCH, commit, {
    env, runRemoteCommand, prefix: 'sflow-configuration-classifier-', cleanupQueueRoot: queueRoot
  });
  return withDisposableReadSnapshot(snapshot.scratch, async () => {
    const workflowBytes = await readOptionalFile(snapshot.scratch, 'singularity/workflow.yml');
    if (!workflowBytes) return Object.freeze({
      branch: CONFIGURATION_BRANCH, commit, status: 'invalid', schemaVersion: null,
      currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
      stateBranch: null, stateProjectionEnabled: false, seedChanges: Object.freeze([]),
      validationError: 'Configuration is missing singularity/workflow.yml.'
    });
    const workflow = parseYaml(workflowBytes, 'Approved workflow');
    const workflowVersion = Number.isInteger(workflow?.version) ? workflow.version : null;
    let hasCapabilityMap = false;
    try {
      hasCapabilityMap = Boolean(await regularFile(
        snapshot.scratch, 'singularity/capabilities.yml'
      ));
    } catch (error) {
      return Object.freeze({
        branch: CONFIGURATION_BRANCH, commit, status: 'invalid', schemaVersion: workflowVersion,
        currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
        stateBranch: null, stateProjectionEnabled: false, seedChanges: Object.freeze([]),
        validationError: error?.message ?? String(error)
      });
    }
    const stateProjectionEnabled = workflow?.ledger?.enabled === true
      && workflow?.ledger?.publication !== 'off';
    let configuredStateBranch;
    try { configuredStateBranch = stateBranchName(workflow?.ledger?.branch); }
    catch (error) {
      return Object.freeze({
        branch: CONFIGURATION_BRANCH, commit, status: 'invalid',
        schemaVersion: workflowVersion,
        currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
        stateBranch: null, stateProjectionEnabled: false, seedChanges: Object.freeze([]),
        validationError: error?.message ?? String(error)
      });
    }
    if (workflowVersion > CURRENT_WORKFLOW_FORMAT_VERSION) return Object.freeze({
      branch: CONFIGURATION_BRANCH, commit, status: 'future', schemaVersion: workflowVersion,
      currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
      stateBranch: configuredStateBranch, stateProjectionEnabled,
      seedChanges: Object.freeze([]), validationError: null
    });
    if (workflowVersion !== CURRENT_WORKFLOW_FORMAT_VERSION) return Object.freeze({
      branch: CONFIGURATION_BRANCH, commit, status: 'invalid', schemaVersion: workflowVersion,
      currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
      stateBranch: configuredStateBranch, stateProjectionEnabled,
      seedChanges: Object.freeze([]),
      validationError: `Workflow schema ${workflowVersion ?? 'unknown'} is not supported for migration by this build.`
    });
    try { await loadDefinition(snapshot.scratch); }
    catch (error) {
      return Object.freeze({
        branch: CONFIGURATION_BRANCH, commit, status: 'invalid', schemaVersion: workflowVersion,
        currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
        stateBranch: configuredStateBranch, stateProjectionEnabled,
        seedChanges: Object.freeze([]), validationError: error?.message ?? String(error)
      });
    }
    const wrote = await initializeDefinition(snapshot.scratch);
    await loadDefinition(snapshot.scratch);
    const changed = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: snapshot.scratch, env: snapshot.env
    }).stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3)).sort();
    const seedChanges = [...new Set([...wrote, ...changed])].sort();
    return Object.freeze({
      branch: CONFIGURATION_BRANCH, commit,
      status: seedChanges.length ? 'migration-required' : 'current',
      schemaVersion: workflowVersion, currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
      stateBranch: configuredStateBranch, stateProjectionEnabled,
      seedChanges: Object.freeze(seedChanges), validationError: null
    });
  }, { cleanupWarnings, cleanupQueueRoot: queueRoot });
}

function observedRefObject(observation, refs) {
  return Object.freeze(Object.fromEntries([...new Set(refs)].sort()
    .map((ref) => [ref, observation.refs.get(ref) ?? null])));
}

function basePreserved() {
  return Object.freeze([
    'application-head', 'application-working-tree', 'application-branches',
    'lifecycle-events', 'non-configuration-state', 'configuration-proposal-refs'
  ]);
}

function choice(id, label, description, mode) {
  return Object.freeze({ id, label, description, mode });
}

function flattenCapabilityNodes(nodes = []) {
  return nodes.flatMap((node) => [node, ...flattenCapabilityNodes(node.children ?? [])]);
}

async function verifyDeliveryLocator(repository, state) {
  try {
    const { readOrganisation } = await import('./organisation.mjs');
    const organisation = await readOrganisation(state.routing.leadUrl, { refresh: true });
    const repositoryIds = Object.entries(organisation.repositories ?? {})
      .filter(([, declaration]) => sameGitRepository(declaration?.url, repository))
      .map(([repositoryId]) => repositoryId);
    const approvedCapabilityIds = flattenCapabilityNodes(organisation.capabilities ?? [])
      .filter((capability) => (capability.repositories ?? [])
        .some((repositoryId) => repositoryIds.includes(repositoryId)))
      .map((capability) => capability.id).sort();
    const linkedCapabilityIds = [...state.routing.capabilityIds].sort();
    const verified = organisation.governed === true && organisation.stale !== true
      && sameGitRepository(organisation.url, state.routing.leadUrl)
      && repositoryIds.length === 1
      && JSON.stringify(approvedCapabilityIds) === JSON.stringify(linkedCapabilityIds);
    return Object.freeze({
      ...state,
      routing: Object.freeze({
        ...state.routing, verified,
        ...(verified ? {
          repositoryId: repositoryIds[0],
          ...(exactCommit(organisation.configurationCommit)
            ? { configurationCommit: organisation.configurationCommit } : {})
        } : {}),
        ...(!verified ? {
          validationError: 'The locator does not match the current approved repository mapping.'
        } : {})
      })
    });
  } catch (error) {
    return Object.freeze({
      ...state,
      routing: Object.freeze({
        ...state.routing, verified: false,
        validationCode: error?.code ?? 'CAPABILITY_AUTHORITY_LINK_UNVERIFIED',
        validationError: error?.message ?? String(error)
      })
    });
  }
}

async function proveLegacyMirrorBinding(repository, state, {
  env, runRemoteCommand, session, cleanupWarnings = [], cleanupQueueRoot = null
}) {
  const queueRoot = repositoryOnboardingCleanupQueueRoot({ env, root: cleanupQueueRoot });
  if (state.kind !== 'configuration-mirror' || state.subjectBound === true
      || !state.history?.branch || !state.history?.commit) return state;
  const ref = `refs/heads/${state.history.branch}`;
  const observed = await session.observeAsync(repository, {
    includeHead: false, refs: [ref]
  });
  if (!observed.ok || observed.refs.get(ref) !== state.history.commit) return state;
  const retained = await cloneObservedBranch(
    repository, state.history.branch, state.history.commit, {
      env, runRemoteCommand, prefix: 'sflow-onboarding-legacy-proof-', cleanupQueueRoot: queueRoot
    }
  );
  return withDisposableReadSnapshot(retained.scratch, async () => {
    try {
      if (!await retainedHistoryMatchesMirror(retained.scratch, state, retained.env)) return state;
      const portfolioFile = await regularFile(retained.scratch, 'singularity/portfolio.yml');
      if (!portfolioFile) return state;
      const portfolio = parseYaml(await readFile(portfolioFile), 'Retained portfolio');
      const repositoryMatches = Object.values(portfolio?.repositories ?? {})
        .filter((entry) => sameGitRepository(entry?.url, repository));
      if (repositoryMatches.length !== 1) return state;
      return Object.freeze({
        ...state,
        repositoryBound: true,
        legacyBinding: Object.freeze({
          method: 'retained-history-and-portfolio',
          branch: state.history.branch,
          commit: state.history.commit
        })
      });
    } catch {
      return state;
    }
  }, { cleanupWarnings, cleanupQueueRoot: queueRoot });
}

function deriveAutomaticSetup(state, configuration) {
  if (state.kind === 'invalid') return {
    status: 'state-branch-not-recognized', primaryAction: 'choose-another-state-branch',
    canApply: false, effects: [], choices: []
  };
  if (state.kind === 'delivery-locator') return {
    status: state.routing?.verified ? 'linked-to-team-configuration' : 'needs-a-choice',
    primaryAction: state.routing?.verified ? 'continue' : 'review-choices',
    canApply: state.routing?.verified === true,
    effects: state.routing?.verified
      ? [{ kind: 'local-registration', target: 'lead-registry', action: 'remember' }] : [],
    choices: []
  };
  if (configuration.status === 'future' || state.compatibility === 'future') return {
    status: 'newer-version-required', primaryAction: 'install-newer-version', canApply: false,
    effects: [], choices: []
  };
  if (configuration.commit) {
    if (configuration.stateBranch && configuration.stateBranch !== state.branch) return {
      status: 'state-branch-not-recognized', primaryAction: 'choose-another-state-branch',
      canApply: false, effects: [], choices: []
    };
    if (configuration.status === 'migration-required') return {
      status: 'update-available', primaryAction: 'migrate-and-continue', canApply: true,
      effects: [
        { kind: 'configuration-migration', target: CONFIGURATION_BRANCH, action: 'propose' },
        { kind: 'local-registration', target: 'lead-registry', action: 'remember' }
      ],
      choices: []
    };
    if (configuration.status === 'invalid') return {
      status: 'needs-a-choice', primaryAction: 'review-choices', canApply: false, effects: [],
      choices: [choice('recreate', 'Recreate configuration',
        'Build current configuration while preserving portable organisation data.', 'recreate')]
    };
    if (configuration.stateProjectionEnabled
        && (['none', 'lifecycle-only'].includes(state.kind)
          || (state.kind === 'configuration-mirror'
            && (state.sourceCommit !== configuration.commit
              || state.repositoryBound !== true)))) return {
      status: 'ready', primaryAction: 'continue', canApply: true,
      effects: [{ kind: 'state-projection', target: state.branch, action: 'refresh' }],
      choices: [], stateRefreshPending: true
    };
    return {
      status: 'ready', primaryAction: 'continue', canApply: true, effects: [], choices: []
    };
  }
  if (state.kind === 'configuration-mirror') {
    if (state.repositoryBound !== true) return {
      status: 'needs-a-choice', primaryAction: 'choose-another-state-branch', canApply: false,
      effects: [], choices: []
    };
    if (!['current', 'migration-required'].includes(state.compatibility)) return {
      status: state.compatibility === 'future' ? 'newer-version-required' : 'needs-a-choice',
      primaryAction: state.compatibility === 'future' ? 'install-newer-version' : 'review-choices',
      canApply: false, effects: [],
      choices: state.compatibility === 'future' ? [] : [choice(
        'recreate', 'Recreate configuration',
        'Build current configuration without interpreting an unsupported older workflow.', 'recreate'
      )]
    };
    if (state.compatibility === 'migration-required') return {
      status: 'update-available', primaryAction: 'migrate-and-continue', canApply: true,
      effects: [
        { kind: 'configuration-restore', target: CONFIGURATION_BRANCH, action: 'create' },
        { kind: 'configuration-migration', target: CONFIGURATION_BRANCH, action: 'propose' },
        { kind: 'state-projection', target: state.branch, action: 'refresh' },
        { kind: 'local-registration', target: 'lead-registry', action: 'remember' }
      ], choices: []
    };
    return {
      status: 'ready-to-restore', primaryAction: 'restore-and-continue', canApply: true,
      effects: [
        { kind: 'configuration-restore', target: CONFIGURATION_BRANCH, action: 'create' },
        { kind: 'state-projection', target: state.branch, action: 'refresh' },
        { kind: 'local-registration', target: 'lead-registry', action: 'remember' }
      ],
      choices: []
    };
  }
  if (state.kind === 'lifecycle-only') return {
    status: 'sflow-repository-capability-not-mapped', primaryAction: 'map-capability',
    canApply: true, effects: [], choices: []
  };
  if (state.kind === 'none') return {
    status: 'not-set-up', primaryAction: 'set-up-sflow', canApply: true,
    effects: [
      { kind: 'configuration-recreate', target: CONFIGURATION_BRANCH, action: 'create' },
      { kind: 'state-projection', target: state.branch, action: 'refresh' },
      { kind: 'local-registration', target: 'lead-registry', action: 'remember' }
    ],
    choices: []
  };
  return {
    status: 'state-branch-not-recognized', primaryAction: 'choose-another-state-branch',
    canApply: false, effects: [], choices: []
  };
}

function deriveModeSetup(mode, state, configuration) {
  if (mode === 'auto') return deriveAutomaticSetup(state, configuration);
  if (mode === 'reset-local') return {
    status: 'ready', primaryAction: 'reset-local-registration', canApply: true,
    effects: [
      { kind: 'local-registration', target: 'lead-registry', action: 'forget' },
      { kind: 'local-cache', target: 'organisation-cache', action: 'delete' }
    ],
    choices: []
  };
  if (state.kind === 'delivery-locator') return {
    status: state.routing?.verified ? 'linked-to-team-configuration' : 'needs-a-choice',
    primaryAction: state.routing?.verified ? 'continue' : 'review-choices', canApply: false,
    effects: [], choices: []
  };
  if (state.kind === 'invalid') return {
    status: 'state-branch-not-recognized', primaryAction: 'choose-another-state-branch',
    canApply: false, effects: [], choices: []
  };
  if (state.kind === 'configuration-mirror' && state.repositoryBound !== true) return {
    status: 'needs-a-choice', primaryAction: 'choose-another-state-branch',
    canApply: false, effects: [], choices: []
  };
  if (mode === 'recreate' && state.kind === 'lifecycle-only') return {
    status: 'sflow-repository-capability-not-mapped', primaryAction: 'map-capability',
    canApply: false, effects: [], choices: []
  };
  if (configuration.status === 'future' || state.compatibility === 'future') return {
    status: 'newer-version-required', primaryAction: 'install-newer-version', canApply: false,
    effects: [], choices: []
  };
  if (mode === 'migrate') {
    const source = Boolean(configuration.commit) || state.kind === 'configuration-mirror';
    const supported = configuration.commit
      ? ['current', 'migration-required'].includes(configuration.status)
      : ['current', 'migration-required'].includes(state.compatibility);
    if (!source || !supported) return {
      status: 'needs-a-choice', primaryAction: 'review-choices', canApply: false, effects: [],
      choices: [choice('recreate', 'Recreate configuration',
        'Build current configuration without guessing how unsupported data should migrate.', 'recreate')]
    };
    const restore = !configuration.commit;
    const changes = configuration.commit ? configuration.seedChanges : state.seedChanges ?? [];
    if (!restore && !changes.length) return {
      status: 'ready', primaryAction: 'continue', canApply: true, effects: [], choices: []
    };
    return {
      status: 'update-available', primaryAction: 'migrate-and-continue', canApply: true,
      effects: [
        ...(restore ? [{ kind: 'configuration-restore', target: CONFIGURATION_BRANCH, action: 'create' }] : []),
        { kind: 'configuration-migration', target: CONFIGURATION_BRANCH, action: 'propose' },
        ...(restore ? [{ kind: 'state-projection', target: state.branch, action: 'refresh' }] : []),
        { kind: 'local-registration', target: 'lead-registry', action: 'remember' }
      ], choices: []
    };
  }
  // Recreate intentionally remains available for an absent, corrupt, or current known schema. It
  // never interprets a future schema and never updates an application/state branch.
  return {
    status: 'update-available', primaryAction: 'recreate-configuration', canApply: true,
    effects: [{
      kind: 'configuration-recreate', target: CONFIGURATION_BRANCH,
      action: configuration.commit ? 'propose' : 'create'
    },
    ...(!configuration.commit
      ? [{ kind: 'state-projection', target: state.branch, action: 'refresh' }] : []),
    { kind: 'local-registration', target: 'lead-registry', action: 'remember' }
    ], choices: []
  };
}

function applicableModes(state, configuration) {
  const migrationRequired = configuration.status === 'migration-required'
    || (!configuration.commit && state.kind === 'configuration-mirror'
      && state.compatibility === 'migration-required');
  return Object.freeze([
    ...(migrationRequired && deriveModeSetup('migrate', state, configuration).canApply
      ? ['migrate'] : []),
    ...(deriveModeSetup('recreate', state, configuration).canApply ? ['recreate'] : []),
    'reset-local'
  ]);
}

function exactEffects(effects, repository, state) {
  return effects.map((effect) => {
    if (effect.target !== 'lead-registry' && effect.target !== 'organisation-cache') {
      return effect;
    }
    const target = state.kind === 'delivery-locator' && effect.action === 'remember'
      ? state.routing?.leadUrl : repository;
    return { ...effect, target: sanitizeRemote(target) };
  });
}

function registeredLocally(registrations, target) {
  return registrations.some((entry) => {
    try { return sameGitRepository(entry?.url, target); }
    catch { return false; }
  });
}

function plansLocalRegistration(plan, target) {
  const display = sanitizeRemote(target);
  return plan.effects.some((effect) => effect.kind === 'local-registration'
    && effect.action === 'remember' && effect.target === display);
}

async function rememberPlannedRegistration(plan, target) {
  if (!plansLocalRegistration(plan, target)) return false;
  await rememberLeadRepository(target);
  return true;
}

function registrationRecovery(plan, target, error) {
  const causeCode = /^[A-Z][A-Z0-9_]*$/u.test(String(error?.code ?? ''))
    ? String(error.code) : null;
  return Object.freeze({
    status: 'pending', remembered: false, target: sanitizeRemote(target),
    code: 'CAPABILITY_LEAD_REGISTRY_WRITE_FAILED',
    ...(causeCode ? { causeCode } : {}),
    reason: 'Remote repository setup was preserved, but this machine could not remember its capability-map repository.',
    retry: Object.freeze({
      shell: onboardingCommand(plan.repository.url),
      copilot: '/sf-capability-map'
    })
  });
}

function withPlanId(core) {
  // Human diagnostics can contain a disposable clone path. Bind confirmation to structured
  // findings and exact refs, never to presentation prose that can change between two inspections.
  const identity = structuredClone(core);
  if (identity.state) {
    delete identity.state.reason;
    delete identity.state.validationError;
  }
  if (identity.configuration) delete identity.configuration.validationError;
  if (identity.failure) delete identity.failure.advice;
  // Local disposable-checkout cleanup is operational diagnostics, not repository authority.
  // Excluding it keeps the exact same ref-bound decision confirmable after a transient lock clears.
  delete identity.localCleanupWarnings;
  const planId = `sha256:${recordSha256(identity)}`;
  return Object.freeze({ ...core, planId });
}

function nextActions(remote, mode, stateBranch, planId = null) {
  return Object.freeze({
    shell: onboardingCommand(remote, { mode, stateBranch, planId }),
    copilot: '/sf-capability-map'
  });
}

/** Inspect one repository and return a deterministic, ref-bound onboarding plan. */
export async function inspectRepositoryOnboarding(remote, {
  mode = 'auto', stateBranch = STATE_BRANCH_DEFAULT, env = process.env,
  remoteSession = null, runRemoteCommand = runRemoteGitAsync,
  cleanupQueueRoot = null
} = {}) {
  const requestedRepository = canonicalRepositoryLocator(remote);
  const repository = await repositoryInputRemote(requestedRepository, env);
  const selectedMode = onboardingMode(mode);
  const branch = stateBranchName(stateBranch);
  const gitEnv = remoteSession?.env ?? enterpriseGitEnvironment(env);
  const queueRoot = repositoryOnboardingCleanupQueueRoot({ env, root: cleanupQueueRoot });

  // Reset is a machine-local operation. It must remain usable while the laptop is offline and
  // must not turn a missing registry entry into a newly-written empty registry file.
  if (selectedMode === 'reset-local') {
    const { organisationCacheFile } = await import('./organisation.mjs');
    const registrations = await listLeadRepositoryRegistryRecords();
    const matchingRegistrations = registrations.filter((entry) => {
      try { return sameGitRepository(entry?.url, repository); }
      catch { return false; }
    });
    const resetTargets = [...new Set([
      repository, ...matchingRegistrations.map((entry) => String(entry.url ?? '').trim())
    ].filter(Boolean))];
    const cachedTargets = [];
    for (const target of resetTargets) {
      const cached = await lstat(organisationCacheFile(target)).then(() => true).catch((error) => {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
        throw error;
      });
      if (cached) cachedTargets.push(target);
    }
    const effects = [
      ...(matchingRegistrations.length ? [{
        kind: 'local-registration', target: sanitizeRemote(repository), action: 'forget'
      }] : []),
      ...cachedTargets.map((target) => ({
        kind: 'local-cache', target: sanitizeRemote(target), action: 'delete'
      }))
    ];
    const core = {
      schemaVersion: 1, // schema-transient: content-addressed preview envelope, never persisted
      kind: REPOSITORY_ONBOARDING_PLAN_KIND,
      repository: repositoryBinding(repository, requestedRepository),
      mode: selectedMode, status: 'ready', primaryAction: 'reset-local-registration',
      state: Object.freeze({ kind: 'none', branch, commit: null }),
      configuration: Object.freeze({
        branch: CONFIGURATION_BRANCH, commit: null, status: 'unchecked', schemaVersion: null,
        currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
        stateBranch: null, stateProjectionEnabled: false,
        seedChanges: Object.freeze([]), validationError: null
      }),
      observedRefs: Object.freeze({}), effects: Object.freeze(effects.map(Object.freeze)),
      preserved: basePreserved(), omitted: Object.freeze([]), choices: Object.freeze([]),
      availableModes: Object.freeze(['reset-local']), canApply: true, dryRun: true,
      localReset: Object.freeze({
        targets: Object.freeze(resetTargets.map(sanitizeRemote)),
        leadRegistrations: matchingRegistrations.length,
        organisationCaches: cachedTargets.length
      })
    };
    const plan = withPlanId(core);
    return Object.freeze({
      ...plan, nextActions: nextActions(requestedRepository, selectedMode, branch, plan.planId)
    });
  }

  const session = remoteSession ?? new GitRemoteSession({
    env: gitEnv, runAsyncCommand: runRemoteCommand
  });
  const cleanupWarnings = [];
  let deferredCleanup;
  try {
    deferredCleanup = await drainRepositoryOnboardingCleanup({ env, root: queueRoot });
  } catch {
    deferredCleanup = Object.freeze({ processed: 0, removed: 0, retained: 0 });
    cleanupWarnings.push(TEMPORARY_CLEANUP_STORAGE_WARNING);
  }
  if (deferredCleanup.retained > 0) cleanupWarnings.push(TEMPORARY_CLEANUP_BACKLOG_WARNING);
  const stateRef = `refs/heads/${branch}`;
  const observation = await session.observeAsync(repository, {
    includeHead: true, refs: [CONFIGURATION_REF, stateRef]
  });
  if (!observation.ok) {
    const core = {
      schemaVersion: 1, // schema-transient: content-addressed preview envelope, never persisted
      kind: REPOSITORY_ONBOARDING_PLAN_KIND,
      repository: repositoryBinding(repository, requestedRepository),
      mode: selectedMode, status: 'could-not-check-git', primaryAction: 'retry',
      state: Object.freeze({ kind: 'none', branch, commit: null }),
      configuration: Object.freeze({
        branch: CONFIGURATION_BRANCH, commit: null, status: 'missing', schemaVersion: null,
        currentSchemaVersion: CURRENT_WORKFLOW_FORMAT_VERSION,
        stateBranch: null, stateProjectionEnabled: false,
        seedChanges: Object.freeze([]), validationError: null
      }),
      observedRefs: Object.freeze({}), effects: Object.freeze([]), preserved: basePreserved(),
      omitted: Object.freeze([]), choices: Object.freeze([]),
      localCleanupWarnings: Object.freeze([...cleanupWarnings]),
      availableModes: Object.freeze(['reset-local']), canApply: false, dryRun: true,
      failure: publicFailure(observation.failure)
    };
    const plan = withPlanId(core);
    return Object.freeze({ ...plan, nextActions: nextActions(requestedRepository, selectedMode, branch) });
  }
  let state = await classifyRepositoryState(repository, {
    stateBranch: branch, observation, env: gitEnv, runRemoteCommand, cleanupWarnings,
    cleanupQueueRoot: queueRoot
  });
  if (state.kind === 'delivery-locator') {
    state = await verifyDeliveryLocator(repository, state);
  } else if (state.kind === 'configuration-mirror' && state.repositoryBound !== true) {
    state = await proveLegacyMirrorBinding(repository, state, {
      env: gitEnv, runRemoteCommand, session, cleanupWarnings, cleanupQueueRoot: queueRoot
    });
  }
  const configurationCommit = observation.refs.get(CONFIGURATION_REF) ?? null;
  const configuration = await inspectConfigurationSnapshot(repository, configurationCommit, {
    env: gitEnv, runRemoteCommand, cleanupWarnings, cleanupQueueRoot: queueRoot
  });
  const setup = deriveModeSetup(selectedMode, state, configuration);
  const relevantRefs = [CONFIGURATION_REF, stateRef];
  const supplementalRefs = [];
  if (state.kind === 'configuration-mirror' && state.history?.branch) {
    const historyRef = `refs/heads/${state.history.branch}`;
    relevantRefs.push(historyRef);
    supplementalRefs.push(historyRef);
  }
  if (!configurationCommit && setup.effects.some((effect) =>
    effect.kind === 'configuration-recreate' && effect.action === 'create')) {
    if (observation.refs.get('HEAD')) relevantRefs.push('HEAD');
  }
  const proposalSource = configurationCommit ?? state.sourceCommit ?? state.commit
    ?? observation.refs.get('HEAD') ?? null;
  const proposalMode = selectedMode === 'auto'
    ? setup.primaryAction === 'migrate-and-continue'
      ? 'migrate'
      : setup.primaryAction === 'restore-and-continue'
        ? 'restore'
        : setup.primaryAction === 'set-up-sflow'
          ? 'create'
          : null
    : selectedMode;
  const proposalBranch = ['create', 'restore', 'migrate', 'recreate'].includes(proposalMode)
      && proposalSource
    ? `${ONBOARDING_REVIEW_PREFIX}${proposalMode}-${proposalSource.slice(0, 12)}`
    : null;
  if (proposalBranch) {
    const proposalRef = `refs/heads/${proposalBranch}`;
    relevantRefs.push(proposalRef);
    supplementalRefs.push(proposalRef);
  }
  let planObservation = observation;
  if (supplementalRefs.length) {
    const supplemental = await session.observeAsync(repository, {
      includeHead: false, refs: supplementalRefs
    });
    if (!supplemental.ok) {
      throw new SingularityFlowError(
        'Repository setup could not inspect the exact recovery refs. Nothing was changed.', {
          code: 'REPOSITORY_ONBOARDING_OBSERVATION_INCOMPLETE',
          details: { failure: publicFailure(supplemental.failure) }
        }
      );
    }
    planObservation = {
      ...observation,
      refs: new Map([...observation.refs, ...supplemental.refs])
    };
  }
  const omitted = selectedMode === 'recreate' && setup.canApply
    ? await previewRecreateOmissions(repository, state, configuration, {
      env: gitEnv, runRemoteCommand, cleanupWarnings, cleanupQueueRoot: queueRoot
    })
    : [];
  const registrations = await listLeadRepositoryRegistryRecords();
  const effects = exactEffects(setup.effects, repository, state).filter((effect) =>
    effect.kind !== 'local-registration' || effect.action !== 'remember'
      || !registeredLocally(registrations, effect.target));
  if (!configurationCommit && proposalBranch
      && effects.some((effect) => effect.target === CONFIGURATION_BRANCH
        && effect.action === 'create')) {
    const source = effects.find((effect) => effect.target === CONFIGURATION_BRANCH
      && effect.action === 'create');
    effects.splice(effects.indexOf(source) + 1, 0, {
      kind: source.kind, target: proposalBranch, action: 'propose'
    });
  }
  if (selectedMode === 'auto' && setup.status === 'ready' && configuration.commit
      && !registeredLocally(registrations, repository)
      && !effects.some((effect) => effect.kind === 'local-registration'
        && effect.action === 'remember')) {
    effects.push({
      kind: 'local-registration', target: sanitizeRemote(repository), action: 'remember'
    });
  }
  const core = {
    schemaVersion: 1, // schema-transient: content-addressed preview envelope, never persisted
    kind: REPOSITORY_ONBOARDING_PLAN_KIND,
    repository: repositoryBinding(repository, requestedRepository),
    mode: selectedMode, status: setup.status, primaryAction: setup.primaryAction,
    state, configuration,
    ...(!configurationCommit && setup.effects.some((effect) =>
      effect.kind === 'configuration-recreate' && effect.action === 'create') ? {
        applicationSource: Object.freeze({
          branch: observation.defaultBranch,
          commit: observation.refs.get('HEAD') ?? null,
          ref: 'HEAD'
        })
      } : {}),
    ...(setup.stateRefreshPending ? {
      stateRefresh: Object.freeze({ status: 'pending', branch: state.branch })
    } : {}),
    ...(state.routing ? { routing: state.routing } : {}),
    ...(proposalBranch ? { proposalBranch } : {}),
    observedRefs: observedRefObject(planObservation, relevantRefs),
    effects: Object.freeze(effects.map((effect) => Object.freeze(effect))),
    preserved: basePreserved(), omitted: Object.freeze(omitted),
    localCleanupWarnings: Object.freeze([...cleanupWarnings]),
    choices: Object.freeze(setup.choices), availableModes: applicableModes(state, configuration),
    canApply: setup.canApply, dryRun: true
  };
  const plan = withPlanId(core);
  return Object.freeze({
    ...plan, nextActions: nextActions(requestedRepository, selectedMode, branch,
      plan.canApply ? plan.planId : null)
  });
}

async function observePlanRefs(remote, plan, { env, runRemoteCommand }) {
  const refs = Object.keys(plan.observedRefs ?? {});
  if (!refs.length) return null;
  const session = new GitRemoteSession({ env, runAsyncCommand: runRemoteCommand });
  const observed = await session.observeAsync(remote, {
    refs, includeHead: false, refresh: true
  });
  if (!observed.ok) {
    throw new SingularityFlowError(
      'Repository setup could not be rechecked immediately before applying the plan. Nothing was changed.', {
        code: 'REPOSITORY_ONBOARDING_APPLY_CHECK_UNAVAILABLE',
        details: { failure: publicFailure(observed.failure), planId: plan.planId }
      }
    );
  }
  const changed = refs.filter((ref) =>
    (observed.refs.get(ref) ?? null) !== (plan.observedRefs[ref] ?? null));
  if (changed.length) {
    throw new SingularityFlowError(
      'Repository setup changed; review the refreshed result. Nothing was changed.', {
        code: 'REPOSITORY_ONBOARDING_PLAN_STALE',
        details: {
          planId: plan.planId, changedRefs: changed,
          expected: Object.fromEntries(changed.map((ref) => [ref, plan.observedRefs[ref] ?? null])),
          actual: Object.fromEntries(changed.map((ref) => [ref, observed.refs.get(ref) ?? null]))
        }
      }
    );
  }
  return { observed, session };
}

async function copyConfigurationFiles(source, destination, { env = process.env } = {}) {
  const policy = configurationAssetPolicyFromRef(source, 'HEAD', { env });
  const files = await configurationAssetPaths(source, policy);
  for (const relative of files) {
    const from = path.join(source, ...relative.split('/'));
    const to = path.join(destination, ...relative.split('/'));
    const info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SingularityFlowError(`Configuration asset '${relative}' is not a regular file.`, {
        code: 'REPOSITORY_ONBOARDING_CONFIGURATION_INVALID'
      });
    }
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
    await chmod(to, info.mode & 0o111 ? 0o755 : 0o644);
  }
  return files;
}

function commitTimestamp(root, ref = 'HEAD', env = process.env) {
  const value = run('git', ['show', '-s', '--format=%cI', ref], {
    cwd: root, env, allowFailure: true
  }).stdout.trim();
  return Number.isFinite(Date.parse(value)) ? value : '2000-01-01T00:00:00Z';
}

function commitCandidate(root, message, {
  env = process.env, timestamp = null, commitIdentity, commitSigning
} = {}) {
  run('git', ['add', '-A'], { cwd: root, env });
  const staged = run('git', ['diff', '--cached', '--quiet'], {
    cwd: root, env, allowFailure: true
  });
  if (staged.status === 0) return null;
  if (staged.status !== 1) {
    throw new SingularityFlowError('The repository setup candidate could not be compared safely.', {
      code: 'REPOSITORY_ONBOARDING_CANDIDATE_INVALID'
    });
  }
  const date = timestamp ?? commitTimestamp(root, 'HEAD', env);
  const signing = commitSigning ?? { required: false, key: null, format: null };
  preflightGitCommitIdentity(root, commitIdentity, { env, signing });
  const commitEnv = {
    ...gitCommitIdentityEnvironment(env, commitIdentity),
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  };
  run('git', [
    ...gitCommitIdentityArgs(commitIdentity), ...gitCommitSigningArgs(signing),
    'commit', '--quiet', ...(signing.required ? ['-S'] : ['--no-gpg-sign']), '-m', message
  ], { cwd: root, env: commitEnv });
  return run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: root, env
  }).stdout.trim();
}

async function selectConfigurationStateBranch(root, branch, { enable = false } = {}) {
  const selected = stateBranchName(branch);
  const file = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(file, 'utf8')) ?? {};
  const configured = String(workflow?.ledger?.branch ?? STATE_BRANCH_DEFAULT);
  if (configured === selected && (!enable || workflow?.ledger?.enabled === true)) return false;
  workflow.ledger = {
    ...(workflow.ledger ?? {}), branch: selected,
    ...(enable ? { enabled: true } : {})
  };
  await writeFile(file, YAML.stringify(workflow));
  return true;
}

async function createConfigurationRootCandidate(remote, plan, {
  env, runRemoteCommand, transform = null, commitIdentity,
  initiatingRoot = process.cwd(), initiatingEnv = process.env,
  cleanupWarnings = [], cleanupQueueRoot = null
}) {
  const queueRoot = repositoryOnboardingCleanupQueueRoot({ env, root: cleanupQueueRoot });
  const frozenCommitIdentity = commitIdentity
    ?? resolveGitCommitIdentity(initiatingRoot, { env: initiatingEnv });
  const candidate = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-candidate-'));
  const objectFormat = String(
    plan.state.commit ?? plan.configuration.commit ?? plan.applicationSource?.commit ?? ''
  ).length === 64
    ? 'sha256' : null;
  run('git', [
    'init', '--quiet', ...(objectFormat ? [`--object-format=${objectFormat}`] : []), candidate
  ], { env });
  run('git', ['symbolic-ref', 'HEAD', `refs/heads/${CONFIGURATION_BRANCH}`], {
    cwd: candidate, env
  });
  let source = null;
  let sourceEnvironment = env;
  let sourceTimestamp = '2000-01-01T00:00:00Z';
  let built = null;
  let primaryFailure = null;
  try {
    if (plan.state.kind === 'configuration-mirror') {
      source = await cloneObservedBranch(
        remote, plan.state.branch, plan.state.commit,
        {
          env, runRemoteCommand, prefix: 'sflow-onboarding-source-',
          cleanupQueueRoot: queueRoot
        }
      );
      sourceEnvironment = source.env;
      sourceTimestamp = commitTimestamp(source.scratch, 'HEAD', source.env);
      await copyConfigurationFiles(source.scratch, candidate, { env: source.env });
    }
    if (transform) await transform(candidate, {
      sourceRoot: source?.scratch ?? null, env: sourceEnvironment
    });
    else if (!source) await initializeDefinition(candidate);
    // An exact mirror restore preserves the reviewed publication policy. Fresh setup and explicit
    // recreate opt into the selected state projection because those modes build current defaults.
    if (!source || transform) {
      await selectConfigurationStateBranch(candidate, plan.state.branch, { enable: true });
    } else {
      await selectConfigurationStateBranch(candidate, plan.state.branch, { enable: false });
    }
    const definition = await loadDefinition(candidate);
    const commitSigning = resolveGitCommitSigning(initiatingRoot, {
      env: initiatingEnv, required: definition.ledger.signing === 'commit'
    });
    const receipt = readRecord('repository-configuration-recovery', {
      schemaVersion: currentSchemaVersion('repository-configuration-recovery'),
      kind: 'repository-configuration-recovery',
      mode: plan.mode,
      planId: plan.planId,
      repositoryIdentity: plan.repository.identity,
      state: {
        branch: plan.state.branch,
        commit: plan.state.commit,
        sourceCommit: plan.state.sourceCommit ?? null
      },
      sourceDigest: `sha256:${recordSha256({
        stateCommit: plan.state.commit,
        sourceCommit: plan.state.sourceCommit ?? null,
        files: plan.state.files ?? []
      })}`
    }).record;
    await mkdir(path.join(candidate, 'singularity', '.product'), { recursive: true });
    await writeFile(path.join(candidate, CONFIGURATION_RECOVERY_RECEIPT), canonicalJson(receipt));
    const commit = commitCandidate(candidate,
      `[configuration] ${plan.mode === 'recreate' ? 'recreate current repository setup' : 'restore verified repository setup'}`,
      {
        env: sourceEnvironment, timestamp: sourceTimestamp,
        commitIdentity: frozenCommitIdentity, commitSigning
      });
    if (!commit) throw new SingularityFlowError(
      'The reconstructed configuration candidate contains no publishable change.', {
        code: 'REPOSITORY_ONBOARDING_CANDIDATE_INVALID'
      }
    );
    built = { candidate, commit, receipt };
  } catch (error) {
    primaryFailure = error;
  }
  if (source) {
    if (primaryFailure) {
      try {
        await withDisposableReadSnapshot(source.scratch, async () => { throw primaryFailure; }, {
          cleanupWarnings, cleanupQueueRoot: queueRoot
        });
      } catch (error) {
        primaryFailure = error;
      }
    } else {
      await withDisposableMutationCheckout(source.scratch, async () => null, {
        cleanupWarnings, cleanupQueueRoot: queueRoot
      });
    }
  }
  if (primaryFailure) return cleanupAfterFailure(candidate, primaryFailure, queueRoot);
  return built;
}

function committedCandidatePaths(root, commit, env) {
  return run('git', [
    'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit, '--',
    'singularity', '.github/agents'
  ], { cwd: root, env }).stdout.split(/\r?\n/u).filter(Boolean).sort();
}

async function publishConfigurationCreationProposal(remote, root, commit, plan, {
  env, runRemoteCommand, session = null
}) {
  const branch = plan?.proposalBranch;
  if (!branch) {
    throw new SingularityFlowError(
      'Repository review fallback was not bound to the confirmed setup plan.', {
        code: 'REPOSITORY_ONBOARDING_REVIEW_REF_UNPLANNED'
      }
    );
  }
  const ref = `refs/heads/${branch}`;
  const expected = plan.observedRefs?.[ref] ?? null;
  const files = committedCandidatePaths(root, commit, env);
  if (expected) {
    return {
      changed: false, branch, commit: expected, candidateCommit: commit, files,
      reviewRequired: true, existing: true, conflict: expected !== commit,
      published: expected === commit
    };
  }
  const transport = frozenRemoteTransport(remote, { push: true, env });
  const pushed = await runRemoteCommand([
    'push', '--porcelain', `--force-with-lease=${ref}:`, '--',
    transport.remote, `${commit}:${ref}`
  ], { cwd: root, operation: 'remote-push', env: transport.env });
  const observer = session ?? new GitRemoteSession({ env, runAsyncCommand: runRemoteCommand });
  observer.invalidate(remote);
  const after = await observer.observeAsync(remote, {
    refs: [ref], includeHead: false, refresh: true
  });
  const current = after.ok ? after.refs.get(ref) ?? null : null;
  if (current === commit) return {
    changed: true, branch, commit, candidateCommit: commit, files,
    reviewRequired: true, existing: false, conflict: false, published: true,
    reconciled: pushed.status !== 0
  };
  if (current) return {
    changed: false, branch, commit: current, candidateCommit: commit, files,
    reviewRequired: true, existing: true, conflict: true, published: false
  };
  throw new SingularityFlowError(
    `Repository setup review proposal '${branch}' could not be published. ${pushed.failure?.advice ?? 'Git rejected the exact create lease.'}`, {
      code: pushed.failure?.code ?? 'REPOSITORY_ONBOARDING_REVIEW_PROPOSAL_FAILED',
      details: { branch, candidateCommit: commit, failure: publicFailure(pushed.failure) }
    }
  );
}

async function publishCreatedConfiguration(remote, root, commit, {
  env, runRemoteCommand, session = null, plan = null
}) {
  // Candidate construction may perform bounded clones and validation. Re-read every source ref
  // from the confirmed plan after that work and immediately before the first remote mutation.
  if (plan) await observePlanRefs(remote, plan, { env, runRemoteCommand });
  const proposalRef = plan?.proposalBranch
    ? `refs/heads/${plan.proposalBranch}` : null;
  const mutableSourceRefs = Object.keys(plan?.observedRefs ?? {}).filter((ref) =>
    ref !== CONFIGURATION_REF && ref !== proposalRef);
  if (mutableSourceRefs.length) {
    // Vanilla Git cannot make creation of one ref conditional on unchanged values of other refs.
    // In particular, `git push --atomic <old>:<same-ref>` is not a guard: the client elides that
    // no-op before receive-pack. A candidate derived from mutable source refs therefore remains on
    // the exact create-leased review branch. A fresh review/activation boundary must make it
    // authoritative; stale source can never create sflow/config here.
    const proposal = await publishConfigurationCreationProposal(
      remote, root, commit, plan, { env, runRemoteCommand, session }
    );
    return {
      commit, reconciled: false, reviewRequired: true, created: false, proposal,
      guardedSourceRefs: mutableSourceRefs
    };
  }
  const transport = frozenRemoteTransport(remote, { push: true, env });
  const pushed = await runRemoteCommand([
    'push', '--porcelain', `--force-with-lease=${CONFIGURATION_REF}:`, '--',
    transport.remote, `${commit}:${CONFIGURATION_REF}`
  ], { cwd: root, operation: 'remote-push', env: transport.env });
  const observer = session ?? new GitRemoteSession({ env });
  observer.invalidate(remote);
  const after = await observer.observeAsync(remote, {
    refs: [CONFIGURATION_REF], includeHead: false, refresh: true
  });
  const current = after.ok ? after.refs.get(CONFIGURATION_REF) ?? null : null;
  if (current === commit) return { commit, reconciled: pushed.status !== 0 };
  if (current) {
    throw new SingularityFlowError(
      'The configuration branch was created concurrently. The winning branch was preserved; review a fresh setup plan.', {
        code: 'REPOSITORY_ONBOARDING_CONFIGURATION_CREATED_CONCURRENTLY',
        details: { plannedCommit: commit, observedCommit: current }
      }
    );
  }
  if (pushed.failure?.classification === 'policy-rejected') {
    const proposal = await publishConfigurationCreationProposal(
      remote, root, commit, plan, { env, runRemoteCommand, session: observer }
    );
    return {
      commit, reconciled: false, reviewRequired: true, created: false, proposal,
      directFailure: {
        code: pushed.failure.code, classification: pushed.failure.classification,
        retryable: pushed.failure.retryable === true
      }
    };
  }
  throw new SingularityFlowError(
    `The configuration branch could not be created. ${pushed.failure?.advice ?? 'Git rejected the exact create lease.'}`, {
      code: pushed.failure?.code ?? 'REPOSITORY_ONBOARDING_CONFIGURATION_CREATE_FAILED',
      details: { failure: publicFailure(pushed.failure) }
    }
  );
}

async function retainedHistoryMatchesMirror(root, state, env) {
  const declared = [...(state.files ?? [])].sort();
  if (!declared.length || !state.assets || typeof state.assets !== 'object') return false;
  let policy;
  let paths;
  try {
    const workflow = YAML.parse(await readFile(
      path.join(root, 'singularity', 'workflow.yml'), 'utf8'
    )) ?? {};
    if (String(workflow?.ledger?.branch ?? STATE_BRANCH_DEFAULT) !== state.branch) return false;
    policy = configurationAssetPolicyFromRef(root, 'HEAD', { env });
    paths = await configurationAssetPaths(root, policy);
  } catch {
    return false;
  }
  if (JSON.stringify(paths) !== JSON.stringify(declared)) return false;
  const entries = configurationTreeEntries(root, 'HEAD', policy, { env });
  for (const relative of declared) {
    const expected = state.assets[relative];
    const actual = entries.get(relative);
    const file = path.join(root, ...relative.split('/'));
    const info = await lstat(file).catch(() => null);
    if (!expected || !actual || !info?.isFile() || info.isSymbolicLink()) return false;
    if (expected.object !== actual.object || expected.mode !== actual.mode
        || expected.sha256 !== sha256(await readFile(file))) return false;
  }
  return true;
}

async function restoreConfiguration(remote, plan, context) {
  const historyBranch = plan.state.history?.branch;
  const historyCommit = plan.state.history?.commit;
  if (historyBranch && historyCommit
      && plan.observedRefs[`refs/heads/${historyBranch}`] === historyCommit) {
    const retained = await cloneObservedBranch(remote, historyBranch, historyCommit, {
      env: context.env, runRemoteCommand: context.runRemoteCommand,
      prefix: 'sflow-onboarding-history-', cleanupQueueRoot: context.cleanupQueueRoot
    });
    const restored = await withDisposableMutationCheckout(retained.scratch, async () => {
      if (await retainedHistoryMatchesMirror(
        retained.scratch, plan.state, retained.env
      )) {
        await loadDefinition(retained.scratch);
        const published = await publishCreatedConfiguration(
          remote, retained.scratch, historyCommit, context
        );
        return {
          ...published, method: 'retained-history', sourceCommit: historyCommit,
          receipt: null
        };
      }
      return null;
    }, context);
    if (restored) return restored;
  }
  const built = await createConfigurationRootCandidate(remote, plan, context);
  return withDisposableMutationCheckout(built.candidate, async () => {
    const published = await publishCreatedConfiguration(
      remote, built.candidate, built.commit, context
    );
    return {
      ...published, method: 'verified-mirror-reconstruction',
      sourceCommit: plan.state.sourceCommit, receipt: built.receipt
    };
  }, context);
}

async function remoteConfigurationClone(remote, expectedCommit, {
  env, runRemoteCommand, prefix = 'sflow-onboarding-configuration-', cleanupQueueRoot = null
}) {
  return cloneObservedBranch(remote, CONFIGURATION_BRANCH, expectedCommit, {
    env, runRemoteCommand, prefix, cleanupQueueRoot
  });
}

async function changedConfigurationPaths(root, env) {
  return run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root, env
  }).stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3)).sort();
}

async function configurationCandidatePaths(root, env = process.env) {
  let policy = DEFAULT_CONFIGURATION_ASSET_POLICY;
  try { policy = configurationAssetPolicyFromRef(root, 'HEAD', { env }); }
  catch { /* Invalid configuration is deliberately replaceable, using bounded default roots. */ }
  let files = [];
  try { files = await configurationAssetPaths(root, policy); }
  catch { /* Tracked path inspection below includes non-regular and otherwise unreadable assets. */ }
  const roots = [...new Set(['singularity', ...policy.roots, ...policy.files])];
  const tracked = run('git', ['ls-files', '-z', '--', ...roots], {
    cwd: root, env, allowFailure: true
  }).stdout.split('\0').filter(Boolean)
    .filter((relative) => isConfigurationAsset(relative, policy));
  return [...new Set([...files, ...tracked])]
    .filter((relative) => relative !== CONFIGURATION_RECOVERY_RECEIPT).sort();
}

async function removeConfigurationPayload(root, env = process.env) {
  const files = await configurationCandidatePaths(root, env);
  for (const relative of files) {
    await rm(path.join(root, ...relative.split('/')), { force: true, recursive: true });
  }
  return files;
}

function portableOrganisationData(sourceRoot) {
  if (!sourceRoot) return { capabilityBytes: null, workflowAuthorities: null, portfolio: {} };
  const optional = async (relative) => {
    const file = path.join(sourceRoot, ...relative.split('/'));
    const info = await lstat(file).catch((error) =>
      error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : Promise.reject(error));
    if (!info || !info.isFile() || info.isSymbolicLink()) return null;
    return readFile(file, 'utf8');
  };
  return Promise.all([
    optional('singularity/capabilities.yml'), optional('singularity/workflow.yml'),
    optional('singularity/portfolio.yml')
  ]).then(([capabilityBytes, workflowBytes, portfolioBytes]) => {
    let workflowAuthorities = null;
    let portfolio = {};
    try {
      const parsed = workflowBytes ? YAML.parse(workflowBytes) : null;
      if (parsed?.approvalAuthorities && typeof parsed.approvalAuthorities === 'object') {
        workflowAuthorities = structuredClone(parsed.approvalAuthorities);
      }
    } catch { /* Corrupt custom configuration is intentionally not interpreted by recreate. */ }
    try {
      const parsed = portfolioBytes ? YAML.parse(portfolioBytes) : null;
      for (const key of ['repositories', 'approvalAuthorities', 'identity']) {
        if (parsed?.[key] && typeof parsed[key] === 'object') {
          portfolio[key] = structuredClone(parsed[key]);
        }
      }
    } catch { /* Corrupt custom configuration is intentionally not interpreted by recreate. */ }
    return { capabilityBytes, workflowAuthorities, portfolio };
  });
}

async function recreateConfigurationInPlace(root, {
  sourceRoot = root, env = process.env, stateBranch = null
} = {}) {
  const portable = await portableOrganisationData(sourceRoot);
  const removed = await removeConfigurationPayload(root, env);
  await initializeDefinition(root);
  if (portable.capabilityBytes) {
    try {
      const parsed = YAML.parse(portable.capabilityBytes);
      if (parsed?.capabilities && typeof parsed.capabilities === 'object') {
        await mkdir(path.join(root, 'singularity'), { recursive: true });
        await writeFile(path.join(root, 'singularity', 'capabilities.yml'), portable.capabilityBytes);
      }
    } catch { /* Omitted and reported by the changed-path preview/result. */ }
  }
  if (portable.workflowAuthorities) {
    const file = path.join(root, 'singularity', 'workflow.yml');
    const workflow = YAML.parse(await readFile(file, 'utf8'));
    workflow.approvalAuthorities = portable.workflowAuthorities;
    await writeFile(file, YAML.stringify(workflow));
  }
  if (Object.keys(portable.portfolio).length) {
    const file = path.join(root, 'singularity', 'portfolio.yml');
    const portfolio = YAML.parse(await readFile(file, 'utf8'));
    Object.assign(portfolio, portable.portfolio);
    await writeFile(file, YAML.stringify(portfolio));
  }
  if (stateBranch) await selectConfigurationStateBranch(root, stateBranch, { enable: true });
  await loadDefinition(root);
  const retained = new Set(await configurationAssetPaths(root));
  return {
    omitted: removed.filter((relative) => !retained.has(relative)).sort()
  };
}

async function configurationHashes(root, env = process.env) {
  const files = await configurationCandidatePaths(root, env);
  const hashes = new Map();
  for (const relative of [...new Set(files)].sort()) {
    const file = path.join(root, ...relative.split('/'));
    const info = await lstat(file).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink()) {
      hashes.set(relative, sha256(await readFile(file)));
    } else if (info) {
      const identity = run('git', ['ls-files', '--stage', '-z', '--', relative], {
        cwd: root, env, allowFailure: true
      }).stdout;
      hashes.set(relative, sha256(Buffer.from(`non-regular:${identity}`, 'utf8')));
    }
  }
  return hashes;
}

/** Compute every configuration path whose exact bytes recreate will not carry forward. */
async function previewRecreateOmissions(remote, state, configuration, {
  env, runRemoteCommand, cleanupWarnings = [], cleanupQueueRoot = null
}) {
  const queueRoot = repositoryOnboardingCleanupQueueRoot({ env, root: cleanupQueueRoot });
  const branch = configuration.commit ? CONFIGURATION_BRANCH
    : state.kind === 'configuration-mirror' ? state.branch : null;
  const commit = configuration.commit ?? (state.kind === 'configuration-mirror'
    ? state.commit : null);
  if (!branch || !commit) return [];
  const snapshot = await cloneObservedBranch(remote, branch, commit, {
    env, runRemoteCommand, prefix: 'sflow-onboarding-recreate-preview-', cleanupQueueRoot: queueRoot
  });
  return withDisposableReadSnapshot(snapshot.scratch, async () => {
    const before = await configurationHashes(snapshot.scratch, snapshot.env);
    await recreateConfigurationInPlace(snapshot.scratch, {
      sourceRoot: snapshot.scratch, env: snapshot.env, stateBranch: state.branch
    });
    const after = await configurationHashes(snapshot.scratch, snapshot.env);
    return [...before].filter(([relative, digest]) => after.get(relative) !== digest)
      .map(([relative]) => relative).sort();
  }, { cleanupWarnings, cleanupQueueRoot: queueRoot });
}

async function publishProposal(remote, plan, mutate, {
  env, runRemoteCommand, expectedConfigurationCommit, commitIdentity,
  initiatingRoot = process.cwd(), initiatingEnv = process.env,
  cleanupWarnings = [], cleanupQueueRoot = null
}) {
  const frozenCommitIdentity = commitIdentity
    ?? resolveGitCommitIdentity(initiatingRoot, { env: initiatingEnv });
  const checkout = await remoteConfigurationClone(remote, expectedConfigurationCommit, {
    env, runRemoteCommand, prefix: 'sflow-onboarding-proposal-', cleanupQueueRoot
  });
  return withDisposableMutationCheckout(checkout.scratch, async () => {
    const result = await mutate(checkout.scratch, { env: checkout.env });
    const definition = await loadDefinition(checkout.scratch);
    const files = await changedConfigurationPaths(checkout.scratch, checkout.env);
    if (!files.length) return {
      changed: false, branch: null, commit: expectedConfigurationCommit,
      files: [], reviewRequired: false, ...result
    };
    const timestamp = commitTimestamp(checkout.scratch, 'HEAD', checkout.env);
    const commitSigning = resolveGitCommitSigning(initiatingRoot, {
      env: initiatingEnv, required: definition.ledger.signing === 'commit'
    });
    const commit = commitCandidate(checkout.scratch,
      `[configuration] ${plan.mode} repository setup`, {
        env: checkout.env, timestamp, commitIdentity: frozenCommitIdentity, commitSigning
      });
    const branch = plan.proposalBranch
      ?? `${ONBOARDING_REVIEW_PREFIX}${plan.mode}-${expectedConfigurationCommit.slice(0, 12)}`;
    const ref = `refs/heads/${branch}`;
    const expectedProposal = plan.observedRefs[ref] ?? null;
    if (expectedProposal && expectedProposal !== commit) {
      return {
        changed: false, branch, commit: expectedProposal, candidateCommit: commit, files,
        reviewRequired: true, existing: true, conflict: true, published: false, ...result
      };
    }
    if (expectedProposal === commit) return {
      changed: false, branch, commit, candidateCommit: commit, files,
      reviewRequired: true, existing: true, conflict: false, published: true, ...result
    };
    const transport = frozenRemoteTransport(remote, { push: true, env: checkout.env });
    const pushed = await runRemoteCommand([
      'push', '--porcelain', `--force-with-lease=${ref}:`, '--',
      transport.remote, `${commit}:${ref}`
    ], { cwd: checkout.scratch, operation: 'remote-push', env: transport.env });
    const observer = new GitRemoteSession({ env, runAsyncCommand: runRemoteCommand });
    const observed = await observer.observeAsync(remote, {
      refs: [ref], includeHead: false, refresh: true
    });
    const current = observed.ok ? observed.refs.get(ref) ?? null : null;
    if (current !== commit) {
      if (current) return {
        changed: false, branch, commit: current, candidateCommit: commit, files,
        reviewRequired: true, existing: true, conflict: true, published: false, ...result
      };
      throw new SingularityFlowError(
        `Repository setup proposal could not be published. ${pushed.failure?.advice ?? 'Git rejected the create lease.'}`, {
          code: pushed.failure?.code ?? 'REPOSITORY_ONBOARDING_PROPOSAL_FAILED',
          details: { branch, plannedCommit: commit, observedCommit: current }
        }
      );
    }
    return {
      changed: true, branch, commit, candidateCommit: commit, files, reviewRequired: true,
      existing: false, conflict: false, published: true,
      reconciled: pushed.status !== 0, ...result
    };
  }, { cleanupWarnings, cleanupQueueRoot });
}

function stateProjectionRetry(remote, plan) {
  // Re-enter the ref-bound onboarding preview rather than the general publish command. The
  // resulting auto-mode plan contains only the pending state projection (and, when needed, local
  // registration), so confirmation cannot repeat the already-published configuration mutation.
  return nextActions(remote, 'auto', plan?.state?.branch ?? STATE_BRANCH_DEFAULT);
}

async function refreshStateProjection(remote, configurationCommit, context) {
  try {
    const { publishOrganisationCapabilityMap } = await import('./organisation.mjs');
    const projection = await publishOrganisationCapabilityMap(remote, {
      expectedConfigurationCommit: configurationCommit,
      initiatingRoot: context.initiatingRoot, initiatingEnv: context.initiatingEnv,
      publishAuthorityLinks: false, allowConfigurationOnly: true,
      retainConfigurationHistory: false
    });
    const pending = !['current', 'updated'].includes(projection.status);
    return {
      ...projection, status: projection.status, pending,
      ...(pending ? { retry: stateProjectionRetry(remote, context.plan) } : {})
    };
  } catch (error) {
    return {
      status: 'pending', pending: true,
      code: error?.code ?? 'CAPABILITY_STATE_PROJECTION_FAILED',
      reason: error?.message ?? String(error),
      retry: stateProjectionRetry(remote, context.plan)
    };
  }
}

function appliedResult(plan, values = {}) {
  const explicitPending = ['configuration-review-required', 'local-registration-pending']
    .includes(values.status);
  const status = !explicitPending && values.stateRefresh?.pending
    ? 'ready-state-refresh-pending'
    : values.status ?? plan.status;
  const stateRetry = status === 'ready-state-refresh-pending'
    ? values.stateRefresh?.retry ?? null
    : null;
  return Object.freeze({
    schemaVersion: 1, // schema-transient: command result envelope, never persisted
    kind: REPOSITORY_ONBOARDING_RESULT_KIND,
    planId: plan.planId, mode: plan.mode, status,
    applied: true, changed: values.changed === true,
    effects: plan.effects, preserved: plan.preserved,
    localCleanupWarnings: Object.freeze([...(plan.localCleanupWarnings ?? [])]),
    availableModes: plan.availableModes,
    ...(plan.routing ? { routing: plan.routing } : {}),
    ...values,
    status, primaryAction: stateRetry ? 'retry' : values.primaryAction ?? plan.primaryAction,
    nextActions: stateRetry ?? values.nextActions ?? Object.freeze({
      shell: onboardingCommand(plan.repository.url),
      copilot: '/sf-capability-map'
    })
  });
}

function reviewRequiredResult(plan, published, { receipt = null, omitted = null } = {}) {
  const proposal = published.proposal;
  const plannedProposal = plan.effects.find((effect) => effect.action === 'propose');
  const proposalEffect = plannedProposal ? {
    ...plannedProposal, target: proposal.branch
  } : null;
  const review = Object.freeze({
    status: proposal.conflict ? 'proposal-conflict' : 'review-required',
    configurationReady: false,
    sourceBranch: proposal.branch,
    targetBranch: CONFIGURATION_BRANCH,
    proposalCommit: proposal.commit,
    candidateCommit: proposal.candidateCommit,
    published: proposal.published === true,
    existing: proposal.existing === true,
    conflict: proposal.conflict === true,
    recovery: Object.freeze({
      action: proposal.conflict ? 'resolve-proposal-conflict' : 'merge-proposal',
      sourceBranch: proposal.branch,
      targetBranch: CONFIGURATION_BRANCH, proposalCommit: proposal.commit,
      afterMerge: onboardingCommand(plan.repository.url)
    })
  });
  return appliedResult(plan, {
    status: 'configuration-review-required', primaryAction: 'review-choices',
    changed: proposal.changed === true,
    effects: proposal.changed === true && proposalEffect ? [proposalEffect] : [], proposal, review,
    ...(receipt ? { receipt } : {}),
    ...(omitted ? { omitted } : {}),
    nextActions: Object.freeze({
      shell: review.recovery.afterMerge, copilot: '/sf-capability-map'
    })
  });
}

async function finishWithRegistration(plan, target, values = {}) {
  const registrationEffect = plan.effects.find((effect) =>
    effect.kind === 'local-registration' && effect.action === 'remember'
      && effect.target === sanitizeRemote(target));
  const completedEffects = (values.effects ?? plan.effects).filter((effect) =>
    !(effect.kind === 'local-registration' && effect.action === 'remember')
      && !(plan.proposalBranch && effect.target === plan.proposalBranch
        && effect.action === 'propose'));
  try {
    const registered = await rememberPlannedRegistration(plan, target);
    return appliedResult(plan, {
      ...values, changed: values.changed === true || registered,
      effects: [...completedEffects, ...(registered && registrationEffect
        ? [registrationEffect] : [])]
    });
  } catch (error) {
    const localRegistration = registrationRecovery(plan, target, error);
    return appliedResult(plan, {
      ...values, status: 'local-registration-pending', primaryAction: 'retry',
      changed: values.changed === true, effects: completedEffects, localRegistration,
      nextActions: localRegistration.retry
    });
  }
}

/** Apply one exact onboarding plan after a final ref comparison. */
export async function applyRepositoryOnboarding(remote, {
  mode = 'auto', stateBranch = STATE_BRANCH_DEFAULT, confirmPlan,
  env = process.env, runRemoteCommand = runRemoteGitAsync,
  cleanupQueueRoot = null
} = {}) {
  const requestedRepository = canonicalRepositoryLocator(remote);
  const repository = await repositoryInputRemote(requestedRepository, env);
  const selectedMode = onboardingMode(mode);
  const confirmation = String(confirmPlan ?? '').trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(confirmation)) {
    throw new SingularityFlowError(
      'Repository onboarding requires the exact --confirm-plan sha256:<PLAN-ID> from --dry-run.', {
        code: 'REPOSITORY_ONBOARDING_CONFIRMATION_REQUIRED'
      }
    );
  }
  const gitEnv = enterpriseGitEnvironment(env);
  let plan = await inspectRepositoryOnboarding(requestedRepository, {
    mode: selectedMode, stateBranch, env: gitEnv, runRemoteCommand, cleanupQueueRoot
  });
  if (plan.planId !== confirmation) {
    throw new SingularityFlowError(
      'Repository setup changed; review the refreshed result. Nothing was changed.', {
        code: 'REPOSITORY_ONBOARDING_CONFIRMATION_MISMATCH',
        details: { confirmedPlanId: confirmation, currentPlanId: plan.planId, refreshedPlan: plan }
      }
    );
  }
  if (!plan.canApply) {
    throw new SingularityFlowError(
      `Repository setup status '${plan.status}' cannot be applied automatically. Nothing was changed.`, {
        code: 'REPOSITORY_ONBOARDING_ACTION_UNAVAILABLE', details: { plan }
      }
    );
  }

  if (selectedMode === 'reset-local') {
    const { organisationCacheFile } = await import('./organisation.mjs');
    let cachesRemoved = 0;
    let registrationsRemoved = 0;
    const targets = plan.localReset?.targets ?? [repository];
    if (plan.effects.some((effect) => effect.kind === 'local-registration'
        && effect.action === 'forget')) {
      await forgetLeadRepository(repository);
      registrationsRemoved = plan.localReset?.leadRegistrations ?? 1;
    }
    for (const target of targets) {
      const cacheFile = organisationCacheFile(target);
      const existed = await lstat(cacheFile).then(() => true).catch((error) => {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
        throw error;
      });
      if (plan.effects.some((effect) => effect.kind === 'local-cache'
          && effect.target === sanitizeRemote(target) && effect.action === 'delete')) {
        await rm(cacheFile, { force: true });
        if (existed) cachesRemoved += 1;
      }
    }
    return appliedResult(plan, {
      status: 'ready', primaryAction: 'continue',
      changed: registrationsRemoved > 0 || cachesRemoved > 0,
      localReset: {
        targets: targets.map(sanitizeRemote), leadRegistrationsRemoved: registrationsRemoved,
        organisationCachesRemoved: cachesRemoved, remoteChanged: false
      }
    });
  }

  const executionCleanupWarnings = [...(plan.localCleanupWarnings ?? [])];
  plan = Object.freeze({ ...plan, localCleanupWarnings: executionCleanupWarnings });
  const applyCleanupQueueRoot = repositoryOnboardingCleanupQueueRoot({
    env, root: cleanupQueueRoot
  });

  const applyCheck = await observePlanRefs(repository, plan, {
    env: gitEnv, runRemoteCommand
  });
  const context = {
    env: gitEnv, runRemoteCommand, session: applyCheck?.session ?? null,
    initiatingRoot: process.cwd(), initiatingEnv: env, plan,
    cleanupWarnings: executionCleanupWarnings,
    cleanupQueueRoot: applyCleanupQueueRoot
  };

  if (selectedMode === 'auto') {
    if (plan.status === 'ready' && plan.effects.some((effect) => effect.kind === 'state-projection'
        && effect.action === 'refresh')) {
      const stateRefresh = await refreshStateProjection(
        repository, plan.configuration.commit, context
      );
      return finishWithRegistration(plan, repository, {
        status: 'ready', primaryAction: 'continue',
        changed: stateRefresh.published === true,
        stateRefresh
      });
    }
    if (plan.status === 'ready') {
      return finishWithRegistration(plan, repository, {
        status: 'ready', primaryAction: 'continue', changed: false
      });
    }
    if (plan.status === 'linked-to-team-configuration') {
      return finishWithRegistration(plan, plan.routing.leadUrl, {
        status: 'linked-to-team-configuration', primaryAction: 'continue', changed: false
      });
    }
    if (plan.status === 'sflow-repository-capability-not-mapped') {
      return appliedResult(plan, {
        status: plan.status, primaryAction: 'map-capability', changed: false
      });
    }
    if (plan.status === 'ready-to-restore') {
      const restored = await restoreConfiguration(repository, plan, context);
      if (restored.reviewRequired) return reviewRequiredResult(plan, restored, {
        receipt: restored.receipt
      });
      const stateRefresh = await refreshStateProjection(repository, restored.commit, context);
      return finishWithRegistration(plan, repository, {
        status: 'ready', primaryAction: 'continue', changed: true,
        configuration: restored, stateRefresh,
        receipt: restored.receipt
      });
    }
    if (plan.status === 'not-set-up') {
      const sourceBranch = plan.applicationSource?.branch ?? null;
      const sourceCommit = plan.applicationSource?.commit ?? null;
      if (!sourceBranch || !sourceCommit) {
        throw new SingularityFlowError(
          'The repository has no application branch from which to create current configuration.', {
            code: 'REPOSITORY_ONBOARDING_SOURCE_BRANCH_MISSING'
          }
        );
      }
      const built = await createConfigurationRootCandidate(repository, plan, context);
      return withDisposableMutationCheckout(built.candidate, async () => {
        const published = await publishCreatedConfiguration(
          repository, built.candidate, built.commit, context
        );
        if (published.reviewRequired) return reviewRequiredResult(plan, published, {
          receipt: { ...built.receipt, sourceBranch, sourceCommit }
        });
        const created = {
          branch: CONFIGURATION_BRANCH, created: true,
          importedFrom: sourceBranch, ...published
        };
        const stateRefresh = await refreshStateProjection(repository, created.commit, context);
        return finishWithRegistration(plan, repository, {
          status: 'ready', primaryAction: 'continue', changed: true,
          configuration: created, stateRefresh,
          receipt: { ...built.receipt, sourceBranch, sourceCommit }
        });
      }, context);
    }
  }

  if (selectedMode === 'migrate'
      || (selectedMode === 'auto' && plan.primaryAction === 'migrate-and-continue')) {
    if (selectedMode === 'migrate' && plan.status === 'ready' && !plan.effects.length) {
      return appliedResult(plan, {
        status: 'ready', primaryAction: 'continue', changed: false
      });
    }
    let restored = null;
    let baseCommit = plan.configuration.commit;
    if (!baseCommit && plan.state.kind === 'configuration-mirror') {
      restored = await restoreConfiguration(repository, plan, context);
      if (restored.reviewRequired) return reviewRequiredResult(plan, restored, {
        receipt: restored.receipt
      });
      baseCommit = restored.commit;
    }
    if (!baseCommit) throw new SingularityFlowError(
      'Migration requires current supported configuration or a verified state mirror.', {
        code: 'REPOSITORY_ONBOARDING_MIGRATION_SOURCE_MISSING'
      }
    );
    const proposal = await publishProposal(repository, plan, async (root) => {
      const wrote = await initializeDefinition(root);
      return { migration: { seedChanges: wrote.sort() } };
    }, { ...context, expectedConfigurationCommit: baseCommit });
    if (proposal.reviewRequired) {
      return reviewRequiredResult(plan, { proposal }, {
        receipt: restored ? { restored, proposal } : { proposal }
      });
    }
    const configurationCommit = proposal.reviewRequired ? baseCommit : proposal.commit;
    const stateRefresh = restored
      ? await refreshStateProjection(repository, configurationCommit, context) : null;
    return finishWithRegistration(plan, repository, {
      status: proposal.reviewRequired ? 'update-available' : 'ready',
      primaryAction: proposal.reviewRequired ? 'review-choices' : 'continue',
      changed: Boolean(restored || proposal.changed), restored, proposal, stateRefresh,
      receipt: { restored, proposal }
    });
  }

  if (selectedMode === 'recreate') {
    if (plan.configuration.commit) {
      const proposal = await publishProposal(repository, plan,
        (root, { env: checkoutEnv }) => recreateConfigurationInPlace(root, {
          sourceRoot: root, env: checkoutEnv, stateBranch: plan.state.branch
        }), {
          ...context,
          expectedConfigurationCommit: plan.configuration.commit
        });
      if (proposal.reviewRequired) {
        return reviewRequiredResult(plan, { proposal }, {
          receipt: { proposal }, omitted: plan.omitted
        });
      }
      return finishWithRegistration(plan, repository, {
        status: proposal.reviewRequired ? 'update-available' : 'ready',
        primaryAction: proposal.reviewRequired ? 'review-choices' : 'continue',
        changed: proposal.changed, proposal,
        omitted: plan.omitted, receipt: { proposal }
      });
    }
    const built = await createConfigurationRootCandidate(repository, plan, {
      ...context,
      transform: (root, { sourceRoot, env: candidateEnv }) =>
        recreateConfigurationInPlace(root, {
          sourceRoot, env: candidateEnv, stateBranch: plan.state.branch
        })
    });
    return withDisposableMutationCheckout(built.candidate, async () => {
      const created = await publishCreatedConfiguration(
        repository, built.candidate, built.commit, context
      );
      if (created.reviewRequired) return reviewRequiredResult(plan, created, {
        receipt: built.receipt, omitted: plan.omitted
      });
      const stateRefresh = await refreshStateProjection(repository, created.commit, context);
      return finishWithRegistration(plan, repository, {
        status: 'ready', primaryAction: 'continue', changed: true,
        configuration: created, stateRefresh, omitted: plan.omitted, receipt: built.receipt
      });
    }, context);
  }

  throw new SingularityFlowError(
    `Repository setup action '${plan.primaryAction}' is not implemented for mode '${selectedMode}'. Nothing was changed.`, {
      code: 'REPOSITORY_ONBOARDING_ACTION_UNAVAILABLE'
    }
  );
}

/** Idempotent API used by the CLI and editor host. */
export async function onboardRepository(remote, {
  dryRun = false, confirmPlan = null, ...options
} = {}) {
  if (dryRun && confirmPlan) {
    throw new SingularityFlowError(
      'Repository onboarding preview cannot also apply a confirmed plan. Use --dry-run first, then --confirm-plan <PLAN-ID>.', {
        code: 'REPOSITORY_ONBOARDING_ARGUMENT_CONFLICT'
      }
    );
  }
  if (!dryRun && !confirmPlan) {
    throw new SingularityFlowError(
      'Repository onboarding writes require --confirm-plan <PLAN-ID>. Run with --dry-run first.', {
        code: 'REPOSITORY_ONBOARDING_CONFIRMATION_REQUIRED'
      }
    );
  }
  return dryRun
    ? inspectRepositoryOnboarding(remote, options)
    : applyRepositoryOnboarding(remote, { ...options, confirmPlan });
}
