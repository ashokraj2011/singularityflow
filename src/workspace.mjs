import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import YAML from 'yaml';
import { normalizeRepositoryMetadata } from './repository-metadata.mjs';
import { localBranches, prepareRemoteBranchTracking, remoteBranches } from './git.mjs';
import {
  buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs
} from './repository-subject-index.mjs';
import { gitWorkerCount, isGitRefName, mapLimit, SingularityFlowError, run } from './util.mjs';
import {
  cloneStrategyArguments, normalizeCloneStrategy, partialCloneConfigured,
  partialCloneFallbackDecision
} from './clone-strategy.mjs';
import {
  assertCredentialFreeRemote, classifyGitRemoteFailure, frozenRemoteTransport,
  remoteFingerprint, safeGitDiagnosticReference, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import {
  GitRemoteSession, requireRemoteObservation, runRemoteGit, runRemoteGitAsync
} from './git-execution.mjs';
import { worktreeFingerprint } from './worktree-fingerprint.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { incrementCommandCounter } from './dx-command-timing.mjs';

export const WORKSPACE_FILE = 'workspace.json';
export const WORKSPACE_SCHEMA_VERSION = 1;
export const MAX_RECENT_WORKSPACES = 20;
const WORKSPACE_REGISTRY_SCHEMA_VERSION = currentSchemaVersion('workspace-registry');
const WORKSPACE_CAPABILITY_DROP_SCHEMA_VERSION = currentSchemaVersion('workspace-capability-drop-transaction');
const registryMutationTails = new Map();
const workspaceDropGitEnvironments = new WeakSet();
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const REGISTRY_LOCK_STALE_MS = 15 * 60_000;
const REGISTRY_LOCK_ACQUISITION_GRACE_MS = 30_000;
const REGISTRY_RECLAIM_GRACE_MS = 30_000;
const REGISTRY_RECLAIM_GENERATIONS = 32;
const REGISTRY_LEASE_PROCESS_STARTED_AT = Math.max(
  0, Math.trunc(Date.now() - process.uptime() * 1_000)
);
const REGISTRY_LEASE_PROCESS_TOKEN = randomUUID();

function nowIso() { return new Date().toISOString(); }

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${label} must be an object.`);
  return value;
}

function safeId(value, label) {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new SingularityFlowError(`${label} must be a portable identifier.`);
  return id;
}

function safeRelative(value, label) {
  const relative = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new SingularityFlowError(`${label} must stay inside the workspace.`);
  return relative;
}

function safeUnder(value, root, label) {
  const relative = safeRelative(value, label);
  if (!relative.startsWith(`${root}/`)) throw new SingularityFlowError(`${label} must live below ${root}/.`);
  return relative;
}

function safeRootOrUnder(value, root, label) {
  const relative = safeRelative(value, label);
  if (relative !== root && !relative.startsWith(`${root}/`)) throw new SingularityFlowError(`${label} must be ${root}/ or live below it.`);
  return relative;
}

function storableRemote(value, { redactCredentials = false } = {}) {
  try { return assertCredentialFreeRemote(value); }
  catch (error) {
    if (!redactCredentials) throw error;
    return assertCredentialFreeRemote(sanitizeRemote(value));
  }
}

function portableName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workspace';
}

function normalizedSiteId(anchor) {
  if (anchor.siteId) return portableName(anchor.siteId.toLowerCase());
  if (!anchor.baseUrl) throw new SingularityFlowError('A Jira siteId or baseUrl is required.');
  let parsed;
  try { parsed = new URL(anchor.baseUrl); } catch {
    throw new SingularityFlowError('The Jira workspace anchor baseUrl must be a valid HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') throw new SingularityFlowError('The Jira workspace anchor must use HTTPS.');
  return portableName(parsed.hostname.toLowerCase());
}

export function normalizeWorkspaceAnchor(input) {
  const anchor = object(input, 'Workspace anchor');
  const provider = anchor.provider ?? 'jira';
  if (provider === 'workspace') {
    const key = safeId(anchor.key, 'Workspace ID');
    return {
      provider: 'workspace',
      siteId: 'local',
      key,
      issueId: null,
      issueTypeId: null,
      issueTypeName: 'Workspace',
      hierarchyLevel: 1,
      title: String(anchor.title ?? key).trim() || key,
      url: null,
      fetchedAt: anchor.fetchedAt ?? nowIso()
    };
  }
  if (provider !== 'jira') throw new SingularityFlowError(`Unsupported workspace anchor provider '${provider}'.`);
  const key = String(anchor.key ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*-\d+$/.test(key)) throw new SingularityFlowError('A valid Jira Epic or higher-level key is required.');
  const hierarchyLevel = Number(anchor.hierarchyLevel);
  if (!Number.isInteger(hierarchyLevel) || hierarchyLevel < 1) {
    throw new SingularityFlowError(`Jira ${key} is below Epic level and cannot anchor a workspace.`);
  }
  const siteId = normalizedSiteId(anchor);
  return {
    provider: 'jira',
    siteId,
    key,
    issueId: anchor.issueId == null ? null : String(anchor.issueId),
    issueTypeId: anchor.issueTypeId == null ? null : String(anchor.issueTypeId),
    issueTypeName: String(anchor.issueTypeName ?? (hierarchyLevel === 1 ? 'Epic' : 'Jira parent')).trim(),
    hierarchyLevel,
    title: String(anchor.title ?? key).trim() || key,
    url: anchor.url == null ? null : String(anchor.url),
    fetchedAt: anchor.fetchedAt ?? nowIso()
  };
}

function normalizeRepositoryJira(value = {}, label) {
  const input = object(value, label);
  const board = String(input.board ?? input.projectKey ?? '').trim();
  if (board.length > 128 || /[\u0000-\u001f\u007f]/.test(board)) {
    throw new SingularityFlowError(`${label}.board must be a printable value up to 128 characters.`);
  }
  return { board: board || null };
}

function normalizeRepository(id, input) {
  const repository = object(input, `Workspace repository '${id}'`);
  const relativePath = safeRelative(repository.path ?? `repos/${id}`, `Workspace repository '${id}' path`);
  if (!relativePath.startsWith('repos/')) throw new SingularityFlowError(`Workspace repository '${id}' must live below repos/.`);
  if (typeof repository.url !== 'string' || !repository.url.trim()) throw new SingularityFlowError(`Workspace repository '${id}' requires a clone URL.`);
  let repositoryUrl;
  try { repositoryUrl = storableRemote(repository.url); }
  catch (error) {
    throw new SingularityFlowError(`Workspace repository '${id}' uses an unsafe clone URL: ${error.message}`);
  }
  const defaultBranch = String(repository.defaultBranch ?? 'main').trim() || 'main';
  if (!isGitRefName(defaultBranch)) {
    throw new SingularityFlowError(`Workspace repository '${id}' has an invalid default branch.`);
  }
  const capabilities = [...new Set((repository.capabilities ?? [])
    .map((capability) => String(capability ?? '').trim())
    .filter(Boolean))].sort();
  for (const capability of capabilities) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capability)) {
      throw new SingularityFlowError(`Workspace repository '${id}' capability '${capability}' must be lower-case kebab-case.`);
    }
  }
  let adoption = null;
  if (repository.adoption != null) {
    const supplied = object(repository.adoption, `Workspace repository '${id}' adoption`);
    if (supplied.mode !== 'existing-clone') {
      throw new SingularityFlowError(`Workspace repository '${id}' has an unsupported adoption mode.`);
    }
    const canonicalPath = path.resolve(String(supplied.canonicalPath ?? ''));
    if (!path.isAbsolute(String(supplied.canonicalPath ?? '')) || canonicalPath === path.parse(canonicalPath).root) {
      throw new SingularityFlowError(`Workspace repository '${id}' adoption requires a safe absolute clone root.`);
    }
    const proofHash = String(supplied.proofHash ?? '');
    if (!/^sha256:[a-f0-9]{64}$/.test(proofHash)) {
      throw new SingularityFlowError(`Workspace repository '${id}' adoption requires a valid proof hash.`);
    }
    adoption = {
      mode: 'existing-clone', canonicalPath, proofHash,
      dirtyAcceptedHash: supplied.dirtyAcceptedHash == null ? null : String(supplied.dirtyAcceptedHash),
      reviewedAt: Number.isFinite(Date.parse(supplied.reviewedAt))
        ? new Date(supplied.reviewedAt).toISOString() : nowIso()
    };
  }
  return {
    id,
    url: repositoryUrl,
    defaultBranch,
    required: repository.required !== false,
    metadata: normalizeRepositoryMetadata(repository.metadata ?? {}, `Workspace repository '${id}' metadata`),
    jira: normalizeRepositoryJira(repository.jira ?? {}, `Workspace repository '${id}' Jira configuration`),
    path: relativePath,
    role: repository.role === 'lead' ? 'lead' : 'participant',
    clone: normalizeCloneStrategy(repository.clone, `Workspace repository '${id}' clone strategy`),
    capabilities,
    adoption
  };
}

/** Resolve a repository without assuming every workspace owns its checkout bytes. */
export function workspaceRepositoryPath(workspace, repository) {
  if (repository.adoption?.mode === 'existing-clone') {
    return path.resolve(repository.adoption.canonicalPath);
  }
  // Repository-scoped branch discovery creates a synthetic repository record whose path is the
  // already-verified checkout root and deliberately has no workspace root. Preserve that absolute
  // path instead of asking path.join() to combine it with null. Real workspace manifests continue
  // to store and resolve only workspace-relative repository paths.
  if (path.isAbsolute(repository.path)) return path.resolve(repository.path);
  return path.join(workspace.path, repository.path);
}

export function validateWorkspaceManifest(input, { workspaceRoot = null } = {}) {
  const manifest = object(structuredClone(input), 'Workspace manifest');
  if (manifest.version !== WORKSPACE_SCHEMA_VERSION) throw new SingularityFlowError(`Workspace manifest version must be ${WORKSPACE_SCHEMA_VERSION}.`);
  manifest.anchor = normalizeWorkspaceAnchor(manifest.anchor);
  manifest.id = manifest.id ?? `${manifest.anchor.siteId}--${manifest.anchor.key}`;
  safeId(manifest.id, 'Workspace ID');
  manifest.name = String(manifest.name ?? `${manifest.anchor.key} — ${manifest.anchor.title}`).trim();
  manifest.leadRepository = safeId(manifest.leadRepository, 'Lead repository ID');
  if (manifest.capabilityAuthority != null) {
    const authority = object(manifest.capabilityAuthority, 'Workspace capability authority');
    let url;
    try { url = storableRemote(authority.url); }
    catch { throw new SingularityFlowError('Workspace capability authority requires a safe credential-free repository URL.'); }
    manifest.capabilityAuthority = { url };
  } else manifest.capabilityAuthority = null;
  // What this workspace is for. A workspace is a set of capabilities and a working directory; the
  // repositories are what those capabilities deliver from. Optional, because a repository can be
  // governed before anyone has described what it builds — and because workspaces created before
  // this existed are still valid.
  manifest.capabilities = [...new Set((manifest.capabilities ?? [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean))].sort();
  for (const id of manifest.capabilities) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new SingularityFlowError(`Workspace capability '${id}' must be lower-case kebab-case.`);
    }
  }
  const rawRepositories = object(manifest.repositories, 'Workspace repositories');
  const repositories = {};
  const paths = new Set();
  for (const [rawId, repository] of Object.entries(rawRepositories)) {
    const id = safeId(rawId, 'Workspace repository ID');
    const normalized = normalizeRepository(id, repository);
    if (paths.has(normalized.path)) throw new SingularityFlowError(`Workspace repositories cannot share path '${normalized.path}'.`);
    paths.add(normalized.path);
    repositories[id] = normalized;
  }
  if (!repositories[manifest.leadRepository]) throw new SingularityFlowError(`Lead repository '${manifest.leadRepository}' is not in the workspace registry.`);
  for (const [id, repository] of Object.entries(repositories)) {
    repository.role = id === manifest.leadRepository ? 'lead' : 'participant';
  }
  manifest.repositories = repositories;
  manifest.directories = {
    stagedDocuments: safeUnder(manifest.directories?.stagedDocuments ?? 'documents/inbox', 'documents', 'Staged-document directory'),
    jiraDocuments: safeUnder(manifest.directories?.jiraDocuments ?? 'documents/jira', 'documents', 'Jira-document directory'),
    imports: safeUnder(manifest.directories?.imports ?? 'documents/imports', 'documents', 'Import directory'),
    exports: safeUnder(manifest.directories?.exports ?? 'documents/exports', 'documents', 'Export directory'),
    jiraCache: safeUnder(manifest.directories?.jiraCache ?? 'cache/jira', 'cache', 'Jira-cache directory'),
    copilotCache: safeUnder(manifest.directories?.copilotCache ?? 'cache/copilot', 'cache', 'Copilot-cache directory'),
    previews: safeUnder(manifest.directories?.previews ?? 'cache/previews', 'cache', 'Preview-cache directory'),
    logs: safeRootOrUnder(manifest.directories?.logs ?? 'logs', 'logs', 'Log directory')
  };
  manifest.createdAt = Number.isFinite(Date.parse(manifest.createdAt)) ? new Date(manifest.createdAt).toISOString() : nowIso();
  manifest.updatedAt = Number.isFinite(Date.parse(manifest.updatedAt)) ? new Date(manifest.updatedAt).toISOString() : manifest.createdAt;
  manifest.localOnly = true;
  if (workspaceRoot) manifest.path = path.resolve(workspaceRoot);
  else delete manifest.path;
  return manifest;
}

export function workspaceDirectoryName(anchor) {
  const normalized = normalizeWorkspaceAnchor(anchor);
  const title = portableName(normalized.title).toLowerCase();
  if (normalized.provider === 'workspace' && title === normalized.key.toLowerCase()) return normalized.key;
  return `${normalized.key}--${title}`;
}

function workspaceDirectories(manifest) {
  return [
    'repos',
    manifest.directories.stagedDocuments,
    manifest.directories.jiraDocuments,
    manifest.directories.imports,
    manifest.directories.exports,
    manifest.directories.jiraCache,
    manifest.directories.copilotCache,
    manifest.directories.previews,
    manifest.directories.logs
  ];
}

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function registryLeaseOwnerAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  // A process-local token distinguishes this process instance from an old lease whose PID the OS
  // recycled back to us. Other PIDs cannot expose their token portably, so their heartbeat age is
  // the authoritative cross-platform fence below; kill(0) only shortens recovery after a crash.
  if (owner.host === os.hostname() && owner.pid === process.pid) {
    return owner.processStartedAt === REGISTRY_LEASE_PROCESS_STARTED_AT
      && owner.processToken === REGISTRY_LEASE_PROCESS_TOKEN;
  }
  if (owner.host && owner.host !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function registryLeaseReclaimIdentity(ownerBytes, info) {
  return createHash('sha256').update(JSON.stringify({
    ownerBytes: ownerBytes ?? null,
    device: String(info?.dev ?? ''),
    inode: String(info?.ino ?? ''),
    birthtimeMs: Number(info?.birthtimeMs ?? 0),
    mtimeMs: Number(info?.mtimeMs ?? 0)
  })).digest('hex').slice(0, 32);
}

function registryLeaseAgeMs(info) {
  return Math.max(0, Date.now() - Number(info?.mtimeMs ?? 0));
}

async function registryLeaseState(lock, {
  staleMs = REGISTRY_LOCK_STALE_MS,
  acquisitionGraceMs = REGISTRY_LOCK_ACQUISITION_GRACE_MS
} = {}) {
  let info;
  try { info = await lstat(lock, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  // The lease is a regular file. An unexpected path type is never interpreted as an abandoned
  // lease because reclaiming it could move an unrelated directory or a symlink target selected by
  // another process.
  if (!info.isFile() || info.isSymbolicLink()) {
    return { info, ownerBytes: null, owner: null, stale: false, reclaimIdentity: null };
  }
  const ownerBytes = await readFile(lock, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (ownerBytes === null) return null;
  let owner = null;
  try { owner = JSON.parse(ownerBytes); } catch { /* malformed abandoned lock */ }
  const ageMs = registryLeaseAgeMs(info);
  const ownerAlive = registryLeaseOwnerAlive(owner);
  // The inode-bound heartbeat is authoritative. A live recycled PID therefore cannot preserve an
  // old lock forever, while a definitely dead owner permits recovery after the short acquisition
  // grace used for a crash between open and owner-record publication.
  const stale = ageMs > staleMs || (!ownerAlive && ageMs > acquisitionGraceMs);
  return {
    info,
    ownerBytes,
    owner,
    ownerAlive,
    ageMs,
    stale,
    reclaimIdentity: registryLeaseReclaimIdentity(ownerBytes, info)
  };
}

function registryReclaimClaimPath(lock, identity, generation) {
  return `${lock}.reclaimed-${identity}-${String(generation).padStart(4, '0')}`;
}

async function registryReclaimDestinationState(destination) {
  let info;
  try { info = await lstat(destination); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    throw error;
  }
  if (info.isSymbolicLink()) return 'invalid';
  if (info.isFile()) return 'retired';
  if (info.isDirectory()) return 'fenced';
  return 'invalid';
}

async function registryReclaimClaimState(claim, {
  reclaimGraceMs = REGISTRY_RECLAIM_GRACE_MS,
  acquisitionGraceMs = REGISTRY_LOCK_ACQUISITION_GRACE_MS
} = {}) {
  let info;
  try { info = await lstat(claim, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SingularityFlowError(
      `The local workspace registry reclaim marker is unsafe: ${claim}. Remove it only after inspection.`,
      { code: 'WORKSPACE_REGISTRY_BUSY' }
    );
  }
  const destination = path.join(claim, 'retired.lock');
  const destinationState = await registryReclaimDestinationState(destination);
  if (destinationState === 'invalid') {
    throw new SingularityFlowError(
      `The local workspace registry reclaim fence is unsafe: ${destination}. Remove it only after inspection.`,
      { code: 'WORKSPACE_REGISTRY_BUSY' }
    );
  }
  let owner = null;
  try { owner = JSON.parse(await readFile(path.join(claim, 'claim.json'), 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const ageMs = registryLeaseAgeMs(info);
  return {
    destination,
    destinationState,
    stale: destinationState === 'missing'
      && (ageMs > reclaimGraceMs
        || (!registryLeaseOwnerAlive(owner) && ageMs > acquisitionGraceMs))
  };
}

async function fenceAbandonedRegistryReclaimClaim(claimState, identity) {
  try {
    await mkdir(claimState.destination, { mode: 0o700 });
  } catch (error) {
    if (['EEXIST', 'EISDIR', 'ENOTDIR'].includes(error?.code)) {
      return registryReclaimDestinationState(claimState.destination);
    }
    throw error;
  }
  // A non-empty directory is an atomic, permanent fence: POSIX and Windows rename cannot replace
  // it with the old lock file if an abandoned claimant later resumes.
  await writeFile(path.join(claimState.destination, 'fenced.claim'), `${identity}\n`, {
    flag: 'wx', mode: 0o600
  });
  return 'fenced';
}

async function invokeRegistryLeaseHook(hooks, name, value) {
  const hook = hooks?.[name];
  if (typeof hook === 'function') await hook(value);
}

/**
 * Reclaim exactly one observed stale lease without a compare-then-unlink successor race.
 *
 * Each deterministic claim generation has a unique `retired.lock` destination. A completed
 * generation retains the old lock there. An abandoned generation is recovered by creating a
 * directory at that destination before advancing to the next generation. That directory is the
 * atomic fence: a paused old claimant can no longer rename either the old lease or a successor into
 * its destination. Claims are never reused or deleted, so delayed contenders cannot regain stale
 * authority over the acquisition pathname.
 */
async function reclaimRegistryFileLease(lock, observed, options = {}) {
  if (!observed?.stale || !observed.reclaimIdentity) return false;
  for (let generation = 0; generation < REGISTRY_RECLAIM_GENERATIONS; generation += 1) {
    const claim = registryReclaimClaimPath(lock, observed.reclaimIdentity, generation);
    let created = false;
    try {
      await mkdir(claim, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!created) {
      const claimState = await registryReclaimClaimState(claim, options);
      if (!claimState) continue;
      if (claimState.destinationState === 'retired') return false;
      if (claimState.destinationState === 'fenced') continue;
      if (!claimState.stale) return false;
      const fenced = await fenceAbandonedRegistryReclaimClaim(
        claimState, observed.reclaimIdentity
      );
      if (fenced === 'retired') return false;
      if (fenced === 'fenced') continue;
      return false;
    }

    const claimToken = randomUUID();
    await writeFile(path.join(claim, 'claim.json'), `${JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      processStartedAt: REGISTRY_LEASE_PROCESS_STARTED_AT,
      processToken: REGISTRY_LEASE_PROCESS_TOKEN,
      claimToken,
      reclaimIdentity: observed.reclaimIdentity,
      createdAt: nowIso()
    })}\n`, { flag: 'wx', mode: 0o600 });
    await invokeRegistryLeaseHook(options.hooks, 'afterClaimCreated', {
      claim, claimToken, generation, observed
    });

    const current = await registryLeaseState(lock, options);
    if (!current || !current.stale
        || current.reclaimIdentity !== observed.reclaimIdentity
        || current.ownerBytes !== observed.ownerBytes
        || String(current.info.dev) !== String(observed.info.dev)
        || String(current.info.ino) !== String(observed.info.ino)) return false;
    const destination = path.join(claim, 'retired.lock');
    await invokeRegistryLeaseHook(options.hooks, 'beforeRetire', {
      claim, destination, claimToken, generation, observed
    });
    try {
      await rename(lock, destination);
      return true;
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(error?.code)) {
        return false;
      }
      throw error;
    }
  }
  throw new SingularityFlowError(
    'The local workspace registry contains too many interrupted reclaim generations. Inspect the retained reclaim markers before retrying.',
    { code: 'WORKSPACE_REGISTRY_BUSY' }
  );
}

function startRegistryLeaseHeartbeat(handle, {
  staleMs = REGISTRY_LOCK_STALE_MS,
  acquisitionGraceMs = REGISTRY_LOCK_ACQUISITION_GRACE_MS
} = {}) {
  const renewalWindowMs = Math.max(40, Math.min(staleMs, acquisitionGraceMs));
  const intervalMs = Math.max(10, Math.min(30_000, Math.floor(renewalWindowMs / 4)));
  const worker = new Worker(`
    const { futimesSync } = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    const stop = () => { clearInterval(timer); parentPort.close(); };
    const beat = () => {
      try {
        const now = new Date();
        futimesSync(workerData.fd, now, now);
      } catch {
        stop();
      }
    };
    const timer = setInterval(beat, workerData.intervalMs);
    parentPort.on('message', stop);
  `, {
    eval: true,
    execArgv: [],
    workerData: { fd: handle.fd, intervalMs }
  });
  // A worker startup failure must not become an unhandled process exception. The bounded lease
  // still expires fail-safe; ordinary asynchronous operations also complete well inside its TTL.
  worker.on('error', () => {});
  worker.unref();
  return worker;
}

async function removeOwnedRegistryLeaseCandidate(lock, handle, acquiredInfo) {
  await handle?.close().catch(() => {});
  let current;
  try { current = await lstat(lock, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (String(current.dev) === String(acquiredInfo?.dev)
      && String(current.ino) === String(acquiredInfo?.ino)) {
    await rm(lock, { force: true });
  }
}

/** @internal Cross-process manifest lease; exported so its race contract can be process-tested. */
export async function withRegistryFileLease(file, operation, options = {}) {
  const lock = `${path.resolve(file)}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  const started = Date.now();
  const token = randomUUID();
  const timeoutMs = options.timeoutMs ?? REGISTRY_LOCK_TIMEOUT_MS;
  let handle;
  let acquiredInfo;
  let heartbeat = null;
  while (!handle) {
    let candidate;
    let candidateHeartbeat = null;
    try {
      candidate = await open(lock, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const observed = await registryLeaseState(lock, options);
      if (observed?.stale) {
        await invokeRegistryLeaseHook(options.hooks, 'afterStaleObserved', { lock, observed });
      }
      if (observed?.stale) {
        const reclaimed = await reclaimRegistryFileLease(lock, observed, options);
        await invokeRegistryLeaseHook(options.hooks, 'afterReclaimAttempt', {
          lock, observed, reclaimed
        });
        if (reclaimed) continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new SingularityFlowError(
          'The local workspace registry is busy in another process. Retry the same command.',
          { code: 'WORKSPACE_REGISTRY_BUSY' }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
      continue;
    }
    try {
      acquiredInfo = await candidate.stat({ bigint: true });
      // Acquisition creates the inode before it can publish owner bytes. Start the inode-bound
      // heartbeat first so a stalled write can never age past the malformed-owner grace and be
      // retired while this process still holds the original descriptor.
      candidateHeartbeat = startRegistryLeaseHeartbeat(candidate, options);
      await invokeRegistryLeaseHook(options.hooks, 'afterLockOpened', {
        lock, token, acquiredInfo
      });
      await candidate.writeFile(`${JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        processStartedAt: REGISTRY_LEASE_PROCESS_STARTED_AT,
        processToken: REGISTRY_LEASE_PROCESS_TOKEN,
        token,
        createdAt: nowIso()
      })}\n`);
      await candidate.sync();
      handle = candidate;
      heartbeat = candidateHeartbeat;
    } catch (error) {
      if (candidateHeartbeat) await candidateHeartbeat.terminate().catch(() => {});
      await removeOwnedRegistryLeaseCandidate(lock, candidate, acquiredInfo).catch(() => {});
      throw error;
    }
  }
  try {
    return await operation();
  } finally {
    if (heartbeat) await heartbeat.terminate().catch(() => {});
    await handle.close().catch(() => {});
    const current = await registryLeaseState(lock, options).catch(() => null);
    if (current?.ownerBytes
        && String(current.info.dev) === String(acquiredInfo?.dev)
        && String(current.info.ino) === String(acquiredInfo?.ino)) {
      try {
        const owner = JSON.parse(current.ownerBytes);
        if (owner?.token === token
            && owner.processToken === REGISTRY_LEASE_PROCESS_TOKEN
            && owner.processStartedAt === REGISTRY_LEASE_PROCESS_STARTED_AT) {
          await rm(lock, { force: true }).catch(() => {});
        }
      } catch { /* A changed or malformed successor is never removed. */ }
    }
  }
}

async function withRegistryMutation(file, operation) {
  const key = path.resolve(file);
  const previous = registryMutationTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => withRegistryFileLease(file, operation));
  registryMutationTails.set(key, current);
  try {
    return await current;
  } finally {
    if (registryMutationTails.get(key) === current) registryMutationTails.delete(key);
  }
}

export async function readWorkspace(workspacePath) {
  const requested = path.resolve(workspacePath);
  const requestedFile = path.basename(requested) === WORKSPACE_FILE ? requested : path.join(requested, WORKSPACE_FILE);
  const fileInfo = await lstat(requestedFile).catch(() => null);
  if (!fileInfo) throw new SingularityFlowError(`Unable to read ${requestedFile}: file does not exist.`);
  if (fileInfo.isSymbolicLink()) throw new SingularityFlowError(`Workspace manifest cannot be a symbolic link: ${requestedFile}`);
  if (!fileInfo.isFile()) throw new SingularityFlowError(`Workspace manifest must be a regular file: ${requestedFile}`);
  const file = await realpath(requestedFile);
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`Unable to read ${file}: ${error.message}`); }
  return validateWorkspaceManifest(parsed, { workspaceRoot: path.dirname(file) });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function workspaceMaterializationPlan(manifest) {
  return stableValue({
    id: manifest.id,
    anchor: {
      provider: manifest.anchor.provider,
      siteId: manifest.anchor.siteId,
      key: manifest.anchor.key
    },
    leadRepository: manifest.leadRepository,
    capabilityAuthority: manifest.capabilityAuthority,
    repositories: Object.fromEntries(Object.entries(manifest.repositories).map(([id, repository]) => [id, {
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      required: repository.required,
      metadata: repository.metadata,
      jira: repository.jira,
      capabilities: repository.capabilities,
      path: repository.path,
      role: repository.role,
      clone: repository.clone,
      adoption: repository.adoption
    }])),
    directories: manifest.directories
  });
}

function sameWorkspaceMaterializationPlan(left, right) {
  return JSON.stringify(workspaceMaterializationPlan(left)) === JSON.stringify(workspaceMaterializationPlan(right));
}

function capabilityBindingSha256(manifest) {
  const binding = stableValue({
    leadRepository: manifest.leadRepository,
    capabilityAuthority: manifest.capabilityAuthority ?? null,
    capabilities: [...new Set(manifest.capabilities ?? [])].sort(),
    repositories: Object.fromEntries(Object.entries(manifest.repositories ?? {}).map(([id, repository]) => [id, {
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      capabilities: [...new Set(repository.capabilities ?? [])].sort()
    }]))
  });
  return `sha256:${createHash('sha256').update(JSON.stringify(binding)).digest('hex')}`;
}

// Validation receipts are a same-process optimization only. Their JSON fields are useful
// diagnostics, but an unkeyed digest is not authority: exported callers (or a modified persisted
// bootstrap session) can reproduce or mutate it. Only immutable claims privately bound to the
// exact object returned by this module may skip the second catalog read, and those claims are still
// re-bound to the current remote configuration ref below.
const liveCapabilityValidationReceipts = new WeakMap();

function immutableCapabilityValidationClaims(validation) {
  return Object.freeze({
    checked: validation.checked === true,
    requested: Object.freeze([...validation.requested]),
    known: Object.freeze([...validation.known]),
    branch: validation.branch,
    path: validation.path,
    commit: validation.commit,
    bindingSha256: validation.bindingSha256
  });
}

function capabilityValidationResult(claims, reused) {
  return {
    checked: claims.checked,
    requested: [...claims.requested],
    known: [...claims.known],
    branch: claims.branch,
    path: claims.path,
    commit: claims.commit,
    bindingSha256: claims.bindingSha256,
    reused
  };
}

function validateRepositoryPlan(repositories, leadRepository) {
  const normalized = {};
  for (const [id, repository] of Object.entries(object(repositories, 'Workspace repositories'))) {
    const safe = safeId(id, 'Workspace repository ID');
    normalized[safe] = normalizeRepository(safe, repository);
  }
  const lead = safeId(leadRepository, 'Lead repository ID');
  if (!normalized[lead]) throw new SingularityFlowError(`Lead repository '${lead}' is not configured.`);
  for (const [id, repository] of Object.entries(normalized)) {
    repository.role = id === lead ? 'lead' : 'participant';
  }
  return { normalized, lead };
}

export function previewWorkspace({
  baseDirectory, anchor, name, repositories, leadRepository, capabilities, capabilityAuthority
}) {
  if (!baseDirectory) throw new SingularityFlowError('Choose a workspace base directory.');
  const normalizedAnchor = normalizeWorkspaceAnchor(anchor);
  const { normalized, lead } = validateRepositoryPlan(repositories, leadRepository);
  const root = path.join(path.resolve(baseDirectory), workspaceDirectoryName(normalizedAnchor));
  return {
    root,
    manifest: validateWorkspaceManifest({
      version: 1,
      id: `${normalizedAnchor.siteId}--${normalizedAnchor.key}`,
      name: name ?? `${normalizedAnchor.key} — ${normalizedAnchor.title}`,
      anchor: normalizedAnchor,
      leadRepository: lead,
      capabilityAuthority,
      repositories: normalized,
      capabilities,
      createdAt: nowIso(),
      updatedAt: nowIso()
    }, { workspaceRoot: root }),
    operations: Object.values(normalized).map((repository) => ({
      action: repository.adoption ? 'adopt' : 'clone',
      repository: repository.id,
      url: repository.url,
      target: repository.adoption?.canonicalPath ?? path.join(root, repository.path),
      branch: repository.defaultBranch,
      required: repository.required,
      clone: repository.clone,
      adoption: repository.adoption
    }))
  };
}

/**
 * Everything a workspace needs to know about a repository, read from the repository itself.
 *
 * Adding a repository by typing an identifier and a clone URL is how a workspace ends up pointing at
 * the wrong fork, or at a branch nobody uses. Pointing at a checkout you already have and reading
 * its origin, its default branch and its folder name removes every one of those chances to be wrong.
 *
 * Refuses anything that is not a repository *root* with an origin: a nested folder would clone the
 * wrong tree, and a repository with no origin cannot be cloned into a workspace at all — which is
 * better said here, while a person is choosing, than during the clone.
 *
 * This belongs to the engine so the CLI and editor use one copy of these rules, for the same reason
 * `extractSourceText` does.
 */
export async function workspaceRepositoryDefaults(repository) {
  const requested = path.resolve(repository ?? '');
  const root = await realpath(requested).catch(() => null);
  const rootInfo = root ? await lstat(root).catch(() => null) : null;
  if (!rootInfo?.isDirectory()) throw new SingularityFlowError(`Repository folder is not available: ${requested}`);

  const gitMetadata = await lstat(path.join(root, '.git')).catch(() => null);
  if (!gitMetadata || gitMetadata.isSymbolicLink() || (!gitMetadata.isDirectory() && !gitMetadata.isFile())) {
    throw new SingularityFlowError(`The selected folder is not a safe Git repository: ${root}`);
  }

  const topLevel = run('git', ['rev-parse', '--show-toplevel'], { cwd: root, allowFailure: true });
  const canonicalTopLevel = topLevel.status === 0 ? await realpath(topLevel.stdout.trim()).catch(() => null) : null;
  if (!canonicalTopLevel || canonicalTopLevel !== root) {
    throw new SingularityFlowError(`Select the Git repository root instead of a nested folder: ${root}`);
  }

  const origin = run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true }).stdout.trim();
  if (!origin) throw new SingularityFlowError(`Repository '${root}' has no origin remote and cannot be cloned into a workspace.`);
  const operationalOrigin = storableRemote(origin, { redactCredentials: true });

  const currentBranch = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true }).stdout.trim();
  if (!currentBranch) throw new SingularityFlowError(`Repository '${root}' has a detached HEAD and cannot be adopted as a workspace checkout.`);

  const remoteHead = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    allowFailure: true
  }).stdout.trim();
  const visibleRemoteBranches = remoteBranches(root, 'origin');
  const defaultBranch = remoteHead.replace(/^origin\//, '')
    || (visibleRemoteBranches.length === 1 ? visibleRemoteBranches[0] : null)
    || visibleRemoteBranches.find((branch) => branch === 'main' || branch === 'master')
    || currentBranch;

  const statusText = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root, allowFailure: true
  }).stdout;
  const fingerprint = worktreeFingerprint(root);
  const worktreeStatusHash = `sha256:${fingerprint.sha256}`;
  const submodules = run('git', ['submodule', 'status', '--recursive'], {
    cwd: root, allowFailure: true
  }).stdout.trim().split('\n').filter(Boolean).slice(0, 100);
  const worktrees = run('git', ['worktree', 'list', '--porcelain'], {
    cwd: root, allowFailure: true
  }).stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
  const tracked = run('git', ['ls-files', '-z'], { cwd: root, allowFailure: true }).stdout.split('\0').filter(Boolean);
  const byCase = new Map();
  const caseCollisions = [];
  for (const file of tracked) {
    const key = file.toLocaleLowerCase('en-US');
    if (byCase.has(key) && byCase.get(key) !== file) caseCollisions.push([byCase.get(key), file]);
    else byCase.set(key, file);
  }
  if (caseCollisions.length) {
    throw new SingularityFlowError(`Repository '${root}' contains case-colliding tracked paths and cannot be safely adopted on this platform.`);
  }
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  const workflowInfo = await lstat(workflowFile).catch(() => null);
  let sflowConfiguration = 'absent';
  if (workflowInfo?.isFile() && !workflowInfo.isSymbolicLink()) {
    try { YAML.parse(await readFile(workflowFile, 'utf8')); sflowConfiguration = 'present'; }
    catch { sflowConfiguration = 'malformed'; }
  }
  const proof = {
    canonicalRoot: root,
    gitMetadata: gitMetadata.isFile() ? 'gitfile' : 'directory',
    origin: operationalOrigin,
    remoteFingerprint: `sha256:${remoteFingerprint(operationalOrigin)}`,
    currentBranch,
    defaultBranch,
    defaultBranchVisible: Boolean(run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${defaultBranch}`], {
      cwd: root, allowFailure: true
    }).status === 0),
    dirty: fingerprint.dirty,
    worktreeStatusHash,
    changedPaths: fingerprint.paths.slice(0, 100),
    submodules,
    worktrees,
    sflowConfiguration
  };
  const proofHash = `sha256:${createHash('sha256').update(JSON.stringify(stableValue(proof))).digest('hex')}`;

  const id = path.basename(root)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'repository';

  return {
    id,
    localPath: root,
    // Persist the same redacted authority that was reviewed in the adoption proof. Credentials in
    // an origin URL are transport material, not workspace configuration, and must never be copied
    // into workspace.json or the local registry.
    url: proof.origin,
    defaultBranch,
    required: true,
    jira: { board: '' },
    metadata: { name: path.basename(root) },
    adoption: { ...proof, mode: 'existing-clone', proofHash }
  };
}

/**
 * Everything a workspace needs to know about a repository it does not have yet.
 *
 * Asking for a checkout first is backwards: the repositories a team governs are named by URL long
 * before anyone clones them, and requiring a local copy makes the first step of setting up a
 * workspace "go and clone three things by hand". `git ls-remote` answers both questions the form
 * needs — what the default branch is, and whether the workflow state branch already exists — over
 * the network without fetching a single object.
 *
 * The state branch matters at this moment because it decides whether this repository is joining a
 * workspace that already records governance history, or starting one.
 */
/**
 * Which branch a remote actually hands you.
 *
 * The symref is the answer when there is one. There is not always one: a bare repository created
 * before its first branch keeps a HEAD pointing at a ref that never appeared, and `ls-remote` then
 * lists the branches without a HEAD line at all. Assuming `main` there invents an answer that is
 * right often enough to hide the times it is wrong — and a workspace cloned on the wrong branch is a
 * confusing thing to debug — so the branches that do exist are consulted first.
 */
export function remoteDefaultBranch(remote, symrefOutput, { env = process.env } = {}) {
  const advertised = advertisedDefaultBranch(symrefOutput);
  if (advertised) return advertised;

  const transport = frozenRemoteTransport(remote, { env });
  const heads = runRemoteGit(['ls-remote', '--heads', transport.remote], {
    operation: 'remote-probe', env: transport.env
  });
  const branches = heads.status === 0
    ? [...heads.stdout.matchAll(/^\S+\s+refs\/heads\/(\S+)$/gm)].map((match) => match[1])
    : [];
  if (branches.length === 1) return branches[0];
  return branches.find((branch) => branch === 'main' || branch === 'master') ?? branches[0] ?? 'main';
}

/** Resolve only the bytes already advertised; this helper never performs hidden network I/O. */
export function advertisedDefaultBranch(symrefOutput) {
  const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(symrefOutput ?? '');
  if (symref?.[1]) return symref[1];

  // Callers that already requested the head namespace must not pay a second synchronous network
  // round trip merely because the remote did not advertise a HEAD symref. This also lets async
  // bootstrap keep every remote operation behind the process-tree supervisor.
  const advertised = [...String(symrefOutput ?? '')
    .matchAll(/^\S+\s+refs\/heads\/(\S+)$/gm)].map((match) => match[1]);
  if (advertised.length) {
    return advertised.find((branch) => branch === 'main' || branch === 'master')
      ?? advertised[0];
  }
  return null;
}

/**
 * Whether a target names somewhere to clone from, rather than a checkout already on disk.
 *
 * The scheme prefixes are the easy half. An absolute path can be either, and the distinction matters
 * because each inspector says something useful the other cannot: reading a checkout can point out
 * that you picked a nested folder or that it has no origin, while ls-remote can read a repository
 * nobody has cloned. So a path that exists is a checkout — unless it is bare, which is a place to
 * clone from and nothing else. A path that does not exist is a remote nobody answers, which is what
 * ls-remote will say.
 *
 * Bare is detected the way Git itself does, by layout, rather than by spawning a process to ask.
 */
export function isCloneTarget(target) {
  const value = String(target ?? '').trim();
  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(value)) return true;
  if (!path.isAbsolute(value)) return false;
  if (!existsSync(value)) return true;
  return ['HEAD', 'objects', 'refs'].every((entry) => existsSync(path.join(value, entry)));
}

export async function workspaceRemoteDefaults(url, {
  stateBranch = 'state', env = process.env
} = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A repository URL is required.');
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(remote) && !remote.startsWith('/')) {
    throw new SingularityFlowError(`'${remote}' is not a clone URL. Use https://, git@, ssh:// or an absolute path.`);
  }

  const gitEnv = enterpriseGitEnvironment(env);
  const session = new GitRemoteSession({ env: gitEnv });
  const stateRef = stateBranch.startsWith('refs/') ? stateBranch : `refs/heads/${stateBranch}`;
  const observed = await session.observeAsync(remote, { includeHead: true, refs: [stateRef] });
  requireRemoteObservation(observed, 'workspace repository');
  let defaultBranch = observed.defaultBranch;
  if (!defaultBranch) {
    const fallback = await session.observeAsync(remote, { includeHead: true, includeAllHeads: true });
    requireRemoteObservation(fallback, 'workspace repository');
    defaultBranch = fallback.defaultBranch
      ?? fallback.branches.find((branch) => branch === 'main' || branch === 'master')
      ?? fallback.branches[0]
      ?? 'main';
  }
  const hasStateBranch = observed.refs.has(stateRef);

  // The last path segment, minus a .git suffix, made safe the same way a local folder name is.
  const id = remote
    // Trailing slashes first: a URL written `…/platform.git/` ends in a slash, so `.git$` does not
    // match and the suffix survives into the identifier.
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop()
    ?.normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'repository';

  return { id, url: remote, defaultBranch, hasStateBranch, stateBranch, localPath: null, required: true };
}

/**
 * The capability map held by a lead repository, read from the remote.
 *
 * A workspace is a set of capabilities and a working directory; the repositories follow from the
 * capabilities, because a delivery capability is the thing that names one. But the map lives inside
 * the lead repository, so it cannot be read until the lead is named — which is why naming the lead
 * by URL comes first and everything else is derived from what comes back.
 *
 * Nothing is checked out and no blobs are fetched beyond the one file: this runs while somebody is
 * still filling in a form, and cloning a monorepo to read four kilobytes of YAML would be felt.
 *
 * @returns the tree and what each capability delivers, or `{ capabilities: null, reason }` when the
 *   lead repository does not describe what it builds — which is a normal state for a new
 *   organisation, not a failure.
 */
export async function workspaceRemoteCapabilities(url, {
  capabilitiesPath = 'singularity/capabilities.yml',
  portfolioPath = 'singularity/portfolio.yml',
  configurationBranch = 'sflow/config',
  env = process.env,
  remoteSession = null
} = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A repository URL is required.');
  const gitEnv = remoteSession?.env ?? enterpriseGitEnvironment(env);
  const operationSession = remoteSession ?? new GitRemoteSession({ env: gitEnv });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-lead-map-'));
  try {
    // Partial clones are refused by some servers and by older Git; without the filter this still
    // works, it just fetches one commit's blobs.
    // Organisation configuration is intentionally independent of application `main`. Workspaces
    // must therefore read the approved configuration branch, never whichever application branch
    // the remote happens to advertise as HEAD.
    const configured = await operationSession.observeAsync(remote, {
      includeHead: false, refs: [`refs/heads/${configurationBranch}`]
    });
    requireRemoteObservation(configured, 'workspace capability authority');
    if (!configured.refs.has(`refs/heads/${configurationBranch}`)) {
      return {
        capabilities: null,
        deliveries: [],
        reason: `${remote} has no approved ${configurationBranch} configuration branch.`,
        path: capabilitiesPath,
        branch: configurationBranch
      };
    }
    const branch = configurationBranch;
    const authorityCommit = configured.refs.get(`refs/heads/${configurationBranch}`);
    const transport = frozenRemoteTransport(remote, { env: gitEnv });
    const clone = (extra) => runRemoteGitAsync([
      'clone', '--quiet', '--depth', '1', '--no-checkout', '--branch', branch, ...extra,
      transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    let cloned = await clone(['--filter=blob:none']);
    let partial = partialCloneFallbackDecision(cloned, {
      configured: cloned.status === 0
        ? partialCloneConfigured(scratch, 'origin', (args, options) => run('git', args, {
            ...options, env: transport.env
          }))
        : null,
      // Catalog reads are disposable, bounded to one shallow authority commit, and historically
      // permit a full transfer when the server explicitly lacks filter support. The shared
      // decision still prevents auth/proxy/TLS/cancel/timeout failures from taking that fallback.
      fallback: 'full'
    });
    // Retry only a server's explicit filter-capability refusal. Replaying authentication, proxy,
    // TLS, timeout, or generic network failures as a full clone doubles the office wait and cannot
    // make those failures succeed. A successful clone that ignored the filter is already the full
    // catalog checkout we need, so retain it rather than downloading it again.
    if (partial.action === 'retry-full') {
      await rm(scratch, { recursive: true, force: true });
      await mkdir(scratch, { recursive: true });
      cloned = await clone([]);
      partial = Object.freeze({ kind: 'full-requested', action: 'retain-full' });
    }
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${sanitizeRemote(remote)}'. ${cloned.failure?.advice ?? 'Git remote access failed.'}`,
        { code: cloned.failure?.code ?? 'REMOTE_UNKNOWN' }
      );
    }
    // This checkout is disposable. Keep its invocation alias active through every object read: a
    // blobless clone may lazy-fetch the catalog during `git show`, and restoring the literal URL
    // before those reads would let ambient insteadOf rules redirect that second transport.
    const clonedCommit = run('git', ['rev-parse', 'HEAD'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    if (clonedCommit !== authorityCommit) {
      throw new SingularityFlowError(
        `Approved capability configuration moved from ${authorityCommit.slice(0, 12)} to ${clonedCommit.slice(0, 12)} while it was being read. Refresh the workspace plan and retry; nothing was changed.`,
        {
          code: 'WORKSPACE_CAPABILITY_CATALOG_STALE',
          details: { branch, expectedCommit: authorityCommit, actualCommit: clonedCommit }
        }
      );
    }

    const shown = run('git', ['show', `HEAD:${capabilitiesPath}`], {
      cwd: scratch, env: transport.env, allowFailure: true
    });
    if (shown.status !== 0) {
      return { capabilities: null, deliveries: [], reason: `${remote} does not contain ${capabilitiesPath}.`, path: capabilitiesPath };
    }

    // The map names repository identifiers; the portfolio is what turns those into somewhere to
    // clone from. Read in the same fetch, because a capability you cannot clone is not a choice.
    const portfolioText = run('git', ['show', `HEAD:${portfolioPath}`], {
      cwd: scratch, env: transport.env, allowFailure: true
    });
    const portfolio = portfolioText.status === 0 ? (YAML.parse(portfolioText.stdout)?.repositories ?? {}) : {};

    const { capabilityTree, flattenCapabilityTree, validateCapabilities } = await import('./capabilities.mjs');
    const definition = validateCapabilities(YAML.parse(shown.stdout));
    const tree = capabilityTree(definition);
    return {
      capabilities: tree,
      // Flat, because the caller's next question is always "which repositories is that?" — and one
      // row per repository rather than per capability, because a capability may ship from several
      // and a list with one row for two repositories answers that question wrongly.
      deliveries: flattenCapabilityTree(tree)
        .flatMap((row) => (row.repositories?.length
          ? row.repositories
          : (row.repository ? [row.repository] : [])).map((repository) => ({ row, repository })))
        .map(({ row, repository }) => ({
          id: row.id,
          name: row.name,
          repository,
          lead: repository === (row.leadRepository ?? repository),
          ancestors: row.ancestors,
          // Null when the capability names a repository the portfolio does not declare — a real
          // state, and one the person choosing needs to see rather than discover at clone time.
          url: portfolio[repository]?.url ?? null,
          defaultBranch: portfolio[repository]?.defaultBranch ?? 'main'
        })),
      reason: null,
      path: capabilitiesPath,
      branch,
      commit: authorityCommit
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function catalogCapabilityIds(nodes, output = new Set()) {
  for (const node of nodes ?? []) {
    if (node?.id) output.add(node.id);
    catalogCapabilityIds(node?.children, output);
  }
  return output;
}

/**
 * Prove every capability named by a workspace against the lead repository's approved authority.
 *
 * The manifest validator deliberately checks shape only: it must remain usable while opening an
 * existing workspace offline. Creation and capability-boundary edits are different — persisting an
 * identifier that the approved sflow/config branch does not know makes the workspace impossible to
 * use for governed work. Those writes therefore cross this remote authority boundary first.
 */
export async function validateWorkspaceCapabilityRegistration(manifest, {
  readCapabilities = workspaceRemoteCapabilities,
  receipt = null,
  observeAuthority = null,
  env = process.env,
  remoteSession = null
} = {}) {
  const workspaceCapabilities = [...new Set(manifest.capabilities ?? [])].sort();
  const repositoryCapabilities = Object.values(manifest.repositories ?? {})
    .flatMap((repository) => repository.capabilities ?? []);
  const requested = [...new Set([...workspaceCapabilities, ...repositoryCapabilities])].sort();
  if (!requested.length) {
    return { checked: false, requested: [], known: [], branch: null, path: null };
  }
  const gitEnv = remoteSession?.env ?? enterpriseGitEnvironment(env);
  const operationSession = remoteSession ?? new GitRemoteSession({ env: gitEnv });

  const leadRepository = manifest.repositories?.[manifest.leadRepository];
  const authorityUrl = manifest.capabilityAuthority?.url ?? leadRepository?.url;
  const authorityLabel = manifest.capabilityAuthority?.url ? 'configured capability authority' : `lead repository '${manifest.leadRepository}'`;
  if (!authorityUrl) {
    throw new SingularityFlowError(
      `Workspace lead repository '${manifest.leadRepository}' has no configuration authority URL. Nothing was changed.`,
      { code: 'WORKSPACE_CAPABILITY_CATALOG_UNAVAILABLE' }
    );
  }

  const bindingSha256 = capabilityBindingSha256(manifest);
  const receiptClaims = receipt && typeof receipt === 'object'
    ? liveCapabilityValidationReceipts.get(receipt)
    : null;
  const receiptBranch = String(receiptClaims?.branch ?? '').trim();
  const receiptCommit = String(receiptClaims?.commit ?? '').trim();
  const receiptMatches = receiptClaims?.checked === true
    && receiptClaims.bindingSha256 === bindingSha256
    && JSON.stringify(receiptClaims.requested) === JSON.stringify(requested)
    && isGitRefName(receiptBranch)
    && /^[0-9a-f]{40,64}$/i.test(receiptCommit);
  if (receiptMatches) {
    const observe = observeAuthority ?? (async (remote, branch) => {
      const observed = await operationSession.observeAsync(remote, {
        includeHead: false, refs: [`refs/heads/${branch}`]
      });
      requireRemoteObservation(observed, 'workspace capability authority');
      return observed.refs.get(`refs/heads/${branch}`) ?? null;
    });
    const currentCommit = await observe(authorityUrl, receiptBranch);
    if (currentCommit === receiptCommit) {
      return capabilityValidationResult(receiptClaims, true);
    }
  }

  let catalog;
  try {
    catalog = await readCapabilities(authorityUrl, {
      env: gitEnv, remoteSession: operationSession
    });
  } catch (error) {
    throw new SingularityFlowError(
      `Cannot validate workspace capabilities against the approved catalog of ${authorityLabel}. `
      + `Nothing was changed. ${error?.message || String(error)}`,
      {
        code: 'WORKSPACE_CAPABILITY_CATALOG_UNAVAILABLE',
        details: { leadRepository: manifest.leadRepository, capabilities: requested }
      }
    );
  }
  if (!catalog?.capabilities) {
    throw new SingularityFlowError(
      `Workspace capabilities cannot be registered because ${authorityLabel} `
      + `has no approved capability catalog. Nothing was changed. ${catalog?.reason ?? ''}`.trim(),
      {
        code: 'WORKSPACE_CAPABILITY_CATALOG_UNAVAILABLE',
        details: {
          leadRepository: manifest.leadRepository,
          capabilities: requested,
          branch: catalog?.branch ?? 'sflow/config',
          path: catalog?.path ?? 'singularity/capabilities.yml'
        }
      }
    );
  }

  const known = catalogCapabilityIds(catalog.capabilities);
  const unknown = requested.filter((capability) => !known.has(capability));
  if (unknown.length) {
    const label = unknown.length === 1
      ? `Capability '${unknown[0]}' is`
      : `Capabilities ${unknown.map((capability) => `'${capability}'`).join(', ')} are`;
    throw new SingularityFlowError(
      `${label} not declared by the approved sflow/config catalog of lead repository `
      + `'${manifest.leadRepository}'. Nothing was changed. Map and approve the capability before `
      + `creating or updating this workspace.`,
      {
        code: 'WORKSPACE_CAPABILITY_UNKNOWN',
        details: {
          leadRepository: manifest.leadRepository,
          capabilities: requested,
          unknown,
          branch: catalog.branch ?? 'sflow/config',
          path: catalog.path ?? 'singularity/capabilities.yml'
        }
      }
    );
  }
  // Capability IDs alone are not enough authority for a workspace plan. A stale or hand-authored
  // manifest could otherwise attach an approved capability name to a different repository, URL,
  // or base branch and pass validation. Recompute the delivery closure from the same exact catalog
  // revision and require every claimed binding to agree before any workspace byte is persisted.
  const selected = new Set(workspaceCapabilities);
  const expectedDeliveries = (catalog.deliveries ?? []).filter((delivery) =>
    selected.has(delivery.id) || (delivery.ancestors ?? []).some((ancestor) => selected.has(ancestor)));
  const expectedByRepository = new Map();
  for (const delivery of expectedDeliveries) {
    const current = expectedByRepository.get(delivery.repository) ?? { capabilities: new Set(), delivery };
    current.capabilities.add(delivery.id);
    expectedByRepository.set(delivery.repository, current);
  }
  const bindingErrors = [];
  for (const [repositoryId, expected] of expectedByRepository) {
    const actual = manifest.repositories?.[repositoryId];
    if (!actual) {
      bindingErrors.push(`missing repository '${repositoryId}' required by ${[...expected.capabilities].sort().join(', ')}`);
      continue;
    }
    if (expected.delivery.url) {
      let expectedUrl = null;
      try { expectedUrl = storableRemote(expected.delivery.url); }
      catch { bindingErrors.push(`repository '${repositoryId}' approved URL is not safe to persist or use`); }
      if (expectedUrl && actual.url !== expectedUrl) {
        bindingErrors.push(`repository '${repositoryId}' URL does not match the approved capability catalog`);
      }
    }
    if (expected.delivery.defaultBranch
        && String(actual.defaultBranch ?? 'main') !== String(expected.delivery.defaultBranch)) {
      bindingErrors.push(`repository '${repositoryId}' base branch must be '${expected.delivery.defaultBranch}'`);
    }
    for (const capability of expected.capabilities) {
      if (!(actual.capabilities ?? []).includes(capability)) {
        bindingErrors.push(`repository '${repositoryId}' is missing capability binding '${capability}'`);
      }
    }
  }
  for (const [repositoryId, repository] of Object.entries(manifest.repositories ?? {})) {
    for (const capability of repository.capabilities ?? []) {
      const expected = expectedByRepository.get(repositoryId);
      if (requested.includes(capability) && !expected?.capabilities.has(capability)) {
        bindingErrors.push(`repository '${repositoryId}' claims capability '${capability}' without an approved delivery binding`);
      }
    }
  }
  if (bindingErrors.length) {
    throw new SingularityFlowError(
      `Workspace repository bindings do not match the approved capability catalog: ${bindingErrors.join('; ')}. Nothing was changed. Refresh the workspace plan and retry.`,
      {
        code: 'WORKSPACE_CAPABILITY_REPOSITORY_MISMATCH',
        details: {
          leadRepository: manifest.leadRepository,
          capabilities: requested,
          branch: catalog.branch ?? 'sflow/config',
          commit: catalog.commit ?? null,
          errors: bindingErrors
        }
      }
    );
  }
  const validation = {
    checked: true,
    requested,
    known: [...known].sort(),
    branch: catalog.branch ?? 'sflow/config',
    path: catalog.path ?? 'singularity/capabilities.yml',
    commit: catalog.commit ?? null,
    bindingSha256,
    reused: false
  };
  liveCapabilityValidationReceipts.set(validation, immutableCapabilityValidationClaims(validation));
  return validation;
}

export function previewWorkspaceConfiguration({
  baseDirectory, id, name, repositories, leadRepository, capabilities, capabilityAuthority
}) {
  const workspaceId = safeId(id, 'Workspace ID');
  const workspaceName = String(name ?? workspaceId).trim();
  if (!workspaceName) throw new SingularityFlowError('Workspace name is required.');
  return previewWorkspace({
    baseDirectory,
    anchor: {
      provider: 'workspace',
      key: workspaceId,
      title: workspaceName
    },
    name: workspaceName,
    repositories,
    leadRepository,
    capabilities,
    capabilityAuthority
  });
}

export function createWorkspaceConfiguration(options, settings = {}) {
  const preview = previewWorkspaceConfiguration(options);
  return createWorkspace({
    baseDirectory: options.baseDirectory,
    anchor: preview.manifest.anchor,
    name: preview.manifest.name,
    repositories: preview.manifest.repositories,
    leadRepository: preview.manifest.leadRepository,
    capabilities: preview.manifest.capabilities,
    capabilityAuthority: preview.manifest.capabilityAuthority
  }, settings);
}

/**
 * Create a machine-local workspace shell around an explicitly selected existing clone.
 * The clone itself is read only: no fetch, checkout, stash, commit, reset, clean, or remote edit.
 */
export async function adoptWorkspaceConfiguration({
  cloneDirectory, id, name = null, baseDirectory, dirtyConfirmation = null
}, { confirmation, dryRun = false } = {}) {
  const defaults = await workspaceRepositoryDefaults(cloneDirectory);
  const workspaceId = safeId(id, 'Workspace ID');
  const repository = {
    url: defaults.url,
    defaultBranch: defaults.defaultBranch,
    required: true,
    metadata: defaults.metadata,
    jira: defaults.jira,
    path: `repos/${defaults.id}`,
    adoption: {
      mode: 'existing-clone',
      canonicalPath: defaults.localPath,
      proofHash: defaults.adoption.proofHash,
      dirtyAcceptedHash: dirtyConfirmation,
      reviewedAt: nowIso()
    }
  };
  const input = {
    baseDirectory,
    id: workspaceId,
    name: name ?? workspaceId,
    repositories: { [defaults.id]: repository },
    leadRepository: defaults.id,
    capabilities: []
  };
  const preview = previewWorkspaceConfiguration(input);
  const plan = {
    schemaVersion: 1, // schema-transient: workspace adoption preview, never persisted
    mode: 'adopt-existing-clone',
    workspace: { id: workspaceId, path: preview.root },
    repository: defaults,
    dirtyConfirmationRequired: defaults.adoption.dirty
      ? defaults.adoption.worktreeStatusHash : null,
    effects: ['create-workspace-shell', 'write-workspace-manifest', 'register-machine-local-workspace'],
    preserved: ['existing-repository-bytes', 'branch', 'HEAD', 'worktree', 'remotes'],
    confirmation: workspaceId
  };
  if (dryRun) return { plan, preview };
  if (defaults.adoption.dirty && dirtyConfirmation !== defaults.adoption.worktreeStatusHash) {
    throw new SingularityFlowError(
      `Existing clone has uncommitted work. Re-run with --confirm-dirty ${defaults.adoption.worktreeStatusHash} after reviewing the listed paths.`,
      { code: 'WORKSPACE_ADOPTION_DIRTY_CONFIRMATION_REQUIRED', details: { plan } }
    );
  }
  const created = await createWorkspaceConfiguration(input, { confirmation, clone: true });
  return { ...created, plan };
}

export async function saveWorkspaceConfiguration(options, { confirmation } = {}) {
  const saved = await createWorkspaceConfiguration(options, { confirmation, clone: false });
  try {
    const materialized = await repairWorkspace(saved.workspace.path);
    return {
      ...saved,
      status: materialized.status,
      repair: materialized.repaired,
      materializationError: null
    };
  } catch (error) {
    return {
      ...saved,
      status: await workspaceStatus(saved.workspace.path),
      repair: [],
      materializationError: error?.message || String(error)
    };
  }
}

function workspaceUpdateManifest(current, { name, repositories, leadRepository, capabilities }) {
  // An edit changes what it names and nothing else. Passing the repositories straight through meant
  // `workspace update --name` reached validateRepositoryPlan with nothing at all and was refused
  // for having no repositories — so renaming a workspace, the safest edit there is, never worked.
  const { normalized, lead } = validateRepositoryPlan(
    repositories ?? current.repositories,
    leadRepository ?? current.leadRepository
  );
  const workspaceName = String(name ?? current.name).trim();
  if (!workspaceName) throw new SingularityFlowError('Workspace name is required.');
  if (capabilities !== undefined) {
    const before = [...new Set(current.capabilities ?? [])].sort();
    const after = [...new Set(capabilities ?? [])].sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new SingularityFlowError(
        'Workspace capability attachments cannot be changed through workspace update. '
        + 'Use workspace attach-capability or workspace detach-capability so repository bindings, local clones, and recovery state change together.',
        { code: 'WORKSPACE_CAPABILITY_TRANSITION_REQUIRED' }
      );
    }
  }
  for (const [id, repository] of Object.entries(current.repositories)) {
    const replacement = normalized[id];
    if (!replacement) {
      throw new SingularityFlowError(`Workspace editing cannot remove existing repository '${id}'. Archive this workspace and create a replacement if its repository boundary changed.`);
    }
    for (const field of ['url', 'defaultBranch', 'path']) {
      if (replacement[field] !== repository[field]) {
        throw new SingularityFlowError(`Workspace editing cannot change ${field} for materialized repository '${id}'. Add a new repository entry instead.`);
      }
    }
    if (JSON.stringify(replacement.clone) !== JSON.stringify(repository.clone)) {
      throw new SingularityFlowError(`Workspace editing cannot change clone strategy for materialized repository '${id}'. Create a replacement workspace instead.`);
    }
    if (JSON.stringify([...(replacement.capabilities ?? [])].sort())
        !== JSON.stringify([...(repository.capabilities ?? [])].sort())) {
      throw new SingularityFlowError(
        `Workspace editing cannot change capability bindings for repository '${id}'. Use workspace attach-capability or workspace detach-capability.`,
        { code: 'WORKSPACE_CAPABILITY_TRANSITION_REQUIRED' }
      );
    }
  }
  for (const [id, repository] of Object.entries(normalized)) {
    if (!current.repositories[id] && (repository.capabilities ?? []).length) {
      throw new SingularityFlowError(
        `Workspace editing cannot introduce capability bindings through new repository '${id}'. Use workspace attach-capability.`,
        { code: 'WORKSPACE_CAPABILITY_TRANSITION_REQUIRED' }
      );
    }
  }
  return validateWorkspaceManifest({
    ...current,
    name: workspaceName,
    leadRepository: lead,
    repositories: normalized,
    capabilities: capabilities ?? current.capabilities ?? [],
    updatedAt: nowIso()
  }, { workspaceRoot: current.path });
}

export async function previewWorkspaceUpdate(workspacePath, options) {
  const current = await readWorkspace(workspacePath);
  const manifest = workspaceUpdateManifest(current, options);
  return {
    root: current.path,
    sourceManifestSha256: workspaceCapabilityChangeSha256(current),
    manifest,
    operations: Object.values(manifest.repositories).map((repository) => ({
      action: current.repositories[repository.id] ? 'update' : 'clone',
      repository: repository.id,
      url: repository.url,
      target: workspaceRepositoryPath(manifest, repository),
      branch: repository.defaultBranch,
      required: repository.required,
      clone: repository.clone
    }))
  };
}

/**
 * Refuse a working directory that another workspace already occupies.
 *
 * A workspace is local and disposable — the point of it is the directory you work in — so two of
 * them sharing one directory is not a conflict to resolve later, it is two sets of governed state
 * writing over each other. `createWorkspace` resumes when it finds the same workspace already
 * there, which is right for creation and wrong for copying: a duplicate that lands on its own
 * source would silently return the original and report success.
 *
 * @param exclude a root that is allowed to be occupied, for callers re-saving a workspace in place.
 */
export async function assertWorkingDirectoryFree(root, { exclude = null } = {}) {
  const resolved = path.resolve(root);
  const canonical = await realpath(resolved).catch(() => resolved);
  if (exclude) {
    const other = path.resolve(exclude);
    if (canonical === (await realpath(other).catch(() => other))) return canonical;
  }
  const existing = await readWorkspace(canonical).catch(() => null);
  if (existing) {
    throw new SingularityFlowError(
      `Working directory is already workspace '${existing.id}': ${canonical}. `
      + 'Choose a different directory; two workspaces cannot share one.');
  }
  const entries = await readdir(canonical).catch(() => null);
  if (entries?.length) {
    throw new SingularityFlowError(`Working directory is not empty: ${canonical}.`);
  }
  return canonical;
}

/**
 * Copy a workspace into a new working directory.
 *
 * Same capabilities, same repositories, same lead — a different place to work. That is the whole
 * operation, because a workspace is only a local grouping: nothing governed lives in it that a
 * second copy would fork. What it must not do is land on the original, which is why the target is
 * asserted free rather than resumed.
 */
export async function duplicateWorkspaceConfiguration(sourcePath, {
  id, name = null, baseDirectory = null
}, settings = {}) {
  const source = await readWorkspace(sourcePath);
  const workspaceId = safeId(id, 'Workspace ID');
  const base = baseDirectory ? path.resolve(baseDirectory) : path.dirname(path.resolve(source.path));
  // The directory a workspace lands in is its identifier — unless its name differs, and then the
  // name is folded in too. A copy named "<source> (copy)" would therefore land in
  // `<id>--<source>-copy` rather than `<id>`, which is not where anybody would look for it.
  // Renaming afterwards moves nothing, so the friendly name is a later decision.

  const preview = previewWorkspaceConfiguration({
    baseDirectory: base,
    id: workspaceId,
    name: name ?? workspaceId,
    leadRepository: source.leadRepository,
    capabilityAuthority: source.capabilityAuthority,
    capabilities: source.capabilities ?? [],
    repositories: Object.fromEntries(Object.entries(source.repositories).map(([key, repository]) => [key, {
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      required: repository.required,
      metadata: repository.metadata,
      jira: repository.jira,
      capabilities: repository.capabilities,
      path: repository.path,
      clone: repository.clone
    }]))
  });
  await assertWorkingDirectoryFree(preview.root);

  return createWorkspaceConfiguration({
    baseDirectory: base,
    id: workspaceId,
    name: name ?? workspaceId,
    leadRepository: source.leadRepository,
    capabilityAuthority: source.capabilityAuthority,
    capabilities: source.capabilities ?? [],
    repositories: preview.manifest.repositories
  }, { ...settings, confirmation: workspaceId });
}

export async function updateWorkspaceConfiguration(workspacePath, options, { confirmation } = {}) {
  const preview = await previewWorkspaceUpdate(workspacePath, options);
  if (confirmation !== preview.manifest.anchor.key) {
    throw new SingularityFlowError(`Workspace editing requires exact workspace confirmation '${preview.manifest.anchor.key}'.`);
  }
  const capabilityBoundaryChanged = options.capabilities !== undefined
    || options.repositories !== undefined
    || options.leadRepository !== undefined;
  if (capabilityBoundaryChanged) await validateWorkspaceCapabilityRegistration(preview.manifest);
  const manifestFile = path.join(preview.root, WORKSPACE_FILE);
  await withRegistryFileLease(manifestFile, async () => {
    const current = await readWorkspace(preview.root);
    if (workspaceCapabilityChangeSha256(current) !== preview.sourceManifestSha256) {
      throw new SingularityFlowError(
        'Workspace configuration changed after the update preview. Nothing was changed; retry the update.',
        { code: 'WORKSPACE_UPDATE_STALE' }
      );
    }
    await atomicJson(manifestFile, preview.manifest);
  });
  const repaired = await repairWorkspaceCapabilityAttachment(preview.root, {
    recoverCapabilityDrops: false
  });
  return {
    updated: true,
    workspace: repaired.status.workspace,
    status: repaired.status,
    repair: repaired.repaired,
    materializationError: repaired.materializationError,
    repairCommand: repaired.materializationError
      ? `singularity-flow workspace repair ${JSON.stringify(preview.root)}` : null
  };
}

function workspaceCapabilityChangeSha256(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function workspaceCapabilityTargetSha256(manifest) {
  // updatedAt is written for human diagnostics, not authority. Excluding only that clock value
  // keeps a preview confirmable when the same immutable source manifest and repository proofs are
  // re-read by the apply command.
  return workspaceCapabilityChangeSha256({ ...manifest, updatedAt: null });
}

function sealWorkspaceCapabilityDropTransaction(record) {
  const unsigned = { ...record };
  delete unsigned.transactionSha256;
  return {
    ...unsigned,
    transactionSha256: workspaceCapabilityChangeSha256(unsigned)
  };
}

function validWorkspaceCapabilityDropTransactionSeal(record) {
  return /^sha256:[0-9a-f]{64}$/.test(String(record?.transactionSha256 ?? ''))
    && sealWorkspaceCapabilityDropTransaction(record).transactionSha256
      === record.transactionSha256;
}

function workspaceCapabilityAuthority(manifest) {
  return manifest.capabilityAuthority?.url
    ?? manifest.repositories?.[manifest.leadRepository]?.url
    ?? null;
}

function dropDirectoryIdentity(info) {
  return info ? { device: String(info.dev), inode: String(info.ino) } : null;
}

function sameDropDirectoryIdentity(left, right) {
  return Boolean(left && right
    && left.device === right.device
    && left.inode === right.inode);
}

function workspaceCapabilityDropNamespaceCollision(repositoryIds) {
  const names = new Map([['transaction.json', 'the transaction receipt']]);
  for (const rawId of repositoryIds) {
    const id = String(rawId ?? '');
    for (const [name, description] of [
      [id, `repository '${id}' staging path`],
      [`${id}.deleting`, `repository '${id}' quarantine path`]
    ]) {
      // Recovery names must remain unambiguous when a workspace moves between case-sensitive and
      // case-insensitive filesystems.
      const key = name.toLowerCase();
      const existing = names.get(key);
      if (existing) return { name, existing, conflicting: description };
      names.set(key, description);
    }
  }
  return null;
}

function assertWorkspaceCapabilityDropNamespace(repositoryIds, {
  code = 'WORKSPACE_CAPABILITY_DROP_UNSAFE_NAMESPACE'
} = {}) {
  const collision = workspaceCapabilityDropNamespaceCollision(repositoryIds);
  if (!collision) return;
  throw new SingularityFlowError(
    `Local-drop recovery namespace collision at '${collision.name}' between ${collision.existing} and ${collision.conflicting}. Nothing was detached or deleted.`,
    { code, details: collision }
  );
}

function comparableWorkspaceDropPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function workspaceDropPathsOverlap(left, right) {
  const first = comparableWorkspaceDropPath(left);
  const second = comparableWorkspaceDropPath(right);
  return first === second
    || first.startsWith(`${second}${path.sep}`)
    || second.startsWith(`${first}${path.sep}`);
}

/**
 * Resolve aliases through the deepest existing ancestor while preserving a missing suffix.
 * Missing checkouts remain eligible for manifest-only detach, but an unreadable or dangling
 * ancestor cannot safely prove that two repository paths are disjoint.
 */
function canonicalWorkspaceDropSafetyPath(target, label) {
  const resolved = path.resolve(target);
  const suffix = [];
  let cursor = resolved;
  while (true) {
    try {
      lstatSync(cursor);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new SingularityFlowError(
          `Local-drop safety could not inspect ${label} path ${resolved}: ${error.message}. Nothing was detached or deleted.`,
          { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
        );
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new SingularityFlowError(
          `Local-drop safety could not resolve ${label} path ${resolved}. Nothing was detached or deleted.`,
          { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
        );
      }
      suffix.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    try {
      return path.resolve(realpathSync(cursor), ...suffix);
    } catch (error) {
      throw new SingularityFlowError(
        `Local-drop safety could not resolve ${label} path ${resolved}: ${error.message}. Nothing was detached or deleted.`,
        { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
      );
    }
  }
}

function assertWorkspaceCapabilityDropPathsIsolated(workspace, candidates) {
  if (!candidates.length) return;
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const candidatePaths = candidates.map((candidate) => ({
    ...candidate,
    resolved: path.resolve(candidate.path),
    canonical: canonicalWorkspaceDropSafetyPath(
      candidate.path, `repository '${candidate.id}' candidate`
    )
  }));
  const retainedPaths = Object.entries(workspace.repositories ?? {})
    .filter(([id]) => !candidateIds.has(id))
    .map(([id, repository]) => {
      const retainedPath = workspaceRepositoryPath(workspace, repository);
      return {
        id,
        resolved: path.resolve(retainedPath),
        canonical: canonicalWorkspaceDropSafetyPath(
          retainedPath, `retained repository '${id}'`
        )
      };
    });
  for (let left = 0; left < candidatePaths.length; left += 1) {
    for (let right = left + 1; right < candidatePaths.length; right += 1) {
      const first = candidatePaths[left];
      const second = candidatePaths[right];
      if (!workspaceDropPathsOverlap(first.resolved, second.resolved)
          && !workspaceDropPathsOverlap(first.canonical, second.canonical)) continue;
      throw new SingularityFlowError(
        `Repositories '${first.id}' and '${second.id}' cannot be dropped together because their checkout paths overlap. Nothing was detached or deleted.`,
        {
          code: 'WORKSPACE_CAPABILITY_DROP_UNSAFE_PATH',
          details: {
            candidateRepository: first.id,
            candidatePath: first.resolved,
            conflictingRepository: second.id,
            conflictingPath: second.resolved
          }
        }
      );
    }
  }
  for (const candidate of candidatePaths) {
    for (const retained of retainedPaths) {
      if (!workspaceDropPathsOverlap(candidate.resolved, retained.resolved)
          && !workspaceDropPathsOverlap(candidate.canonical, retained.canonical)) continue;
      throw new SingularityFlowError(
        `Repository '${candidate.id}' cannot be dropped because its checkout path overlaps retained repository '${retained.id}'. Nothing was detached or deleted.`,
        {
          code: 'WORKSPACE_CAPABILITY_DROP_UNSAFE_PATH',
          details: {
            candidateRepository: candidate.id,
            candidatePath: candidate.resolved,
            retainedRepository: retained.id,
            retainedPath: retained.resolved
          }
        }
      );
    }
  }
}

function workspaceDropGitEnvironment(env = null) {
  const base = env ?? enterpriseGitEnvironment();
  if (workspaceDropGitEnvironments.has(base)) return base;
  // A deletion proof is read-only and must never hydrate a partial clone merely to inspect its
  // object database. Besides avoiding an unexpected network side effect, this keeps an offline
  // proof bounded when a promisor remote is unavailable. Disable repository-local filesystem
  // monitor and untracked-cache shortcuts as well: those are performance hints whose stale or
  // executable answers must never hide bytes from a destructive proof.
  const offset = Number(base.GIT_CONFIG_COUNT ?? 0);
  const configurationOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const overrides = [
    ['core.fsmonitor', 'false'],
    ['core.untrackedCache', 'false'],
    ['core.ignorecase', 'false'],
    ...(process.platform === 'win32' ? [] : [['core.filemode', 'true']]),
    ['http.sslVerify', 'true'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false']
  ];
  const isolated = {
    ...base,
    GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_COUNT: String(configurationOffset + overrides.length)
  };
  overrides.forEach(([key, value], index) => {
    isolated[`GIT_CONFIG_KEY_${configurationOffset + index}`] = key;
    isolated[`GIT_CONFIG_VALUE_${configurationOffset + index}`] = value;
  });
  workspaceDropGitEnvironments.add(isolated);
  return isolated;
}

async function workspaceDropLstat(target, options = undefined) {
  try {
    return await lstat(target, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SingularityFlowError(
      `Local-drop safety could not inspect ${target}: ${error.message}. Nothing was detached or deleted.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
}

async function assertWorkspaceDropLocalGitConfiguration(repository, target, {
  env = null
} = {}) {
  const gitEnv = workspaceDropGitEnvironment(env);
  const keys = [];
  for (const scope of ['local', 'worktree']) {
    const result = run('git', [
      'config', `--${scope}`, '--includes', '--name-only', '--null', '--list'
    ], { cwd: target, env: gitEnv, allowFailure: true });
    if (result.status !== 0) {
      throw new SingularityFlowError(
        `Repository '${repository.id}' ${scope} Git configuration could not be inspected safely. Nothing was dropped.`,
        { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
      );
    }
    keys.push(...result.stdout.split('\0'));
  }
  const unsafe = [...new Set(keys.map((key) => key.trim().toLowerCase())
    .filter(Boolean)
    .filter((key) => (
      key.startsWith('http.')
      || key.startsWith('credential.')
      || key.startsWith('url.')
      || key.startsWith('protocol.')
      || key.startsWith('include.')
      || key.startsWith('includeif.')
      || ['core.askpass', 'core.gitproxy', 'core.sshcommand', 'core.hookspath'].includes(key)
      || (/^remote\.[^.]+\.(?:proxy|proxyauthmethod|uploadpack|receivepack|vcs)$/).test(key)
    )))].sort();
  if (unsafe.length) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' has local Git transport or executable configuration (${unsafe.join(', ')}) that cannot participate in a destructive publication proof. Remove the repository-local override or detach without --drop-local. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_GIT_CONFIG', details: { keys: unsafe } }
    );
  }
}

async function gitWriterLocks(gitDirectory) {
  const locks = [];
  const rootEntries = await readdir(gitDirectory, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isSymbolicLink() && entry.name.endsWith('.lock')) locks.push(entry.name);
  }
  const roots = ['refs', 'logs', 'reftable', 'objects/pack', 'objects/info'];
  const pending = roots.map((relative) => path.join(gitDirectory, relative));
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      inspected += 1;
      if (inspected > 20_000) {
        throw new SingularityFlowError(
          'Git writer-lock inspection exceeded its bounded metadata inventory.',
          { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
        );
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.name.endsWith('.lock')) locks.push(path.relative(gitDirectory, absolute));
      if (entry.isDirectory()) pending.push(absolute);
    }
  }
  return [...new Set(locks)].sort();
}

function equalDropDirectoryIdentity(left, right) {
  return (!left && !right) || sameDropDirectoryIdentity(left, right);
}

function gitRefRows(result, label) {
  if (result.status !== 0) {
    throw new SingularityFlowError(`${label} could not be verified. Nothing was dropped.`, {
      code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED'
    });
  }
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, sha, upstream = ''] = line.split('\t');
    if (!ref?.startsWith('refs/') || !/^[0-9a-f]{40,64}$/i.test(sha ?? '')) {
      throw new SingularityFlowError(`${label} returned an invalid Git reference. Nothing was dropped.`, {
        code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED'
      });
    }
    return { ref, sha, upstream };
  });
}

async function workspaceRepositoryReferenceProof(repository, target, {
  env = enterpriseGitEnvironment()
} = {}) {
  const refs = gitRefRows(run('git', [
    'for-each-ref', '--format=%(refname)%09%(objectname)%09%(upstream)', 'refs/'
  ], { cwd: target, env, allowFailure: true }), `Repository '${repository.id}' local references`);
  const localTags = new Map();
  for (const entry of refs) {
    if (entry.ref.startsWith('refs/heads/')) {
      const branchName = entry.ref.slice('refs/heads/'.length);
      const expectedUpstream = `refs/remotes/origin/${branchName}`;
      const published = entry.upstream === expectedUpstream
        && run('git', ['merge-base', '--is-ancestor', entry.sha, expectedUpstream], {
          cwd: target, env, allowFailure: true
        }).status === 0;
      if (!published) {
        throw new SingularityFlowError(
          `Repository '${repository.id}' has local branch '${branchName}' that is not published under origin/${branchName}. Push or preserve it before using Detach & drop local.`,
          { code: 'WORKSPACE_CAPABILITY_DROP_UNPUSHED' }
        );
      }
      continue;
    }
    if (entry.ref.startsWith('refs/tags/')) {
      localTags.set(entry.ref, entry.sha);
      continue;
    }
    if (entry.ref.startsWith('refs/remotes/origin/')) continue;
    throw new SingularityFlowError(
      `Repository '${repository.id}' has local Git reference '${entry.ref}' outside the reviewed origin namespace. Preserve or remove it before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNPUSHED' }
    );
  }

  const transport = frozenRemoteTransport(repository.url, { env });
  const remoteTagResult = await runRemoteGitAsync([
    'ls-remote', '--tags', '--refs', '--', transport.remote
  ], { cwd: target, operation: 'remote-configuration', env: transport.env });
  if (remoteTagResult.status !== 0) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' remote tags could not be verified. Nothing was dropped. ${remoteTagResult.failure?.advice ?? 'Restore Git access and retry.'}`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  const remoteTags = new Map();
  for (const line of remoteTagResult.stdout.split(/\r?\n/).filter(Boolean)) {
    const [sha, ref] = line.split(/\s+/);
    if (!ref?.startsWith('refs/tags/') || !/^[0-9a-f]{40,64}$/i.test(sha ?? '')) {
      throw new SingularityFlowError(
        `Repository '${repository.id}' remote tag inventory was invalid. Nothing was dropped.`,
        { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
      );
    }
    remoteTags.set(ref, sha);
  }
  for (const [ref, sha] of localTags) {
    if (remoteTags.get(ref) !== sha) {
      throw new SingularityFlowError(
        `Repository '${repository.id}' has local tag '${ref.slice('refs/tags/'.length)}' that is not published unchanged on origin. Preserve or push it before using Detach & drop local.`,
        { code: 'WORKSPACE_CAPABILITY_DROP_UNPUSHED' }
      );
    }
  }
  return workspaceCapabilityChangeSha256({
    // Remote-tracking refs are live publication evidence, not local state identity. They are
    // refreshed and checked above on every proof, but excluding them from the durable fingerprint
    // lets recovery tolerate an unrelated origin branch advancing while still rejecting any local
    // branch, tag, stash, or custom-ref change.
    refs: refs.filter(({ ref }) => !ref.startsWith('refs/remotes/origin/'))
      .map(({ ref, sha, upstream }) => ({ ref, sha, upstream })),
    remoteTags: [...localTags.keys()].sort().map((ref) => ({ ref, sha: remoteTags.get(ref) }))
  });
}

/**
 * Prove that an owned repository checkout can be removed without discarding local work.
 *
 * A clean worktree is not enough: another linked worktree or a commit absent from every
 * remote-tracking ref is local work too. Adopted repositories are never owned by the workspace and
 * therefore can never be dropped through this operation.
 */
async function workspaceRepositoryDropProof(workspace, repository, status, {
  targetPath = null,
  env = null
} = {}) {
  const target = targetPath ? path.resolve(targetPath) : workspaceRepositoryPath(workspace, repository);
  // Deletion authority must come from the checkout named by `target`, never from ambient Git
  // selectors such as GIT_DIR, GIT_INDEX_FILE, alternates, namespaces, or replacement objects.
  // The same isolated environment is reused by every local and remote proof in this invocation.
  const gitEnv = workspaceDropGitEnvironment(env);
  if (repository.adoption) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' is an adopted checkout and is not owned by this workspace. Detach the capability without --drop-local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_ADOPTED' }
    );
  }
  await assertInside(workspace.path, target);
  const info = await workspaceDropLstat(target, { bigint: true });
  if (!info) {
    return {
      id: repository.id, path: target, state: 'missing', head: null,
      worktreeSha256: null, refsSha256: null, directoryIdentity: null, removable: false
    };
  }
  if (info.isSymbolicLink() || !info.isDirectory() || status?.state !== 'ready') {
    throw new SingularityFlowError(
      `Repository '${repository.id}' cannot be dropped because its local checkout is ${status?.state ?? 'invalid'}. Repair or remove it manually after inspection.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNSAFE_PATH' }
    );
  }
  const observedHead = gitValue(target, ['rev-parse', '--verify', 'HEAD'], { env: gitEnv });
  if (!/^[0-9a-f]{40,64}$/i.test(String(observedHead ?? ''))) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' HEAD could not be verified from its own checkout. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  const canonicalCheckout = await realpath(target);
  await assertWorkspaceDropLocalGitConfiguration(repository, target, { env: gitEnv });
  const configuredTopLevel = gitValue(target, ['rev-parse', '--show-toplevel'], {
    env: gitEnv
  });
  const canonicalTopLevel = configuredTopLevel
    ? await realpath(configuredTopLevel).catch(() => null) : null;
  if (!canonicalTopLevel || canonicalTopLevel !== canonicalCheckout) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' Git worktree resolves outside its managed checkout. Detach it without --drop-local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_EXTERNAL_GIT_DIR' }
    );
  }
  const fingerprint = worktreeFingerprint(target, {
    fresh: true, env: gitEnv, exhaustive: true
  });
  if (fingerprint.dirty || status?.dirty) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' has uncommitted or hidden work. Commit and push it, or preserve it outside this checkout, before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_DIRTY' }
    );
  }
  const ignored = run('git', [
    'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'
  ], { cwd: target, env: gitEnv, allowFailure: true });
  if (ignored.status !== 0) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' ignored-file safety could not be verified. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  if (ignored.stdout.split(/\r?\n/).some((line) => line.startsWith('!! '))) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' contains ignored local files. Preserve or explicitly remove them before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_IGNORED' }
    );
  }
  const submodules = run('git', ['submodule', 'status', '--recursive'], {
    cwd: target, env: gitEnv, allowFailure: true
  });
  if (submodules.status !== 0) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' submodule state could not be verified. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  const initializedSubmodule = submodules.stdout.split(/\r?\n/)
    .find((line) => line && !line.startsWith('-'));
  if (initializedSubmodule) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' has an initialized submodule. Deinitialize or preserve it before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_SUBMODULE' }
    );
  }
  const absoluteGitDirectory = gitValue(target, ['rev-parse', '--absolute-git-dir'], { env: gitEnv });
  if (!absoluteGitDirectory) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' Git object directory could not be verified. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  const canonicalGitDirectory = await realpath(absoluteGitDirectory).catch(() => null);
  if (!canonicalGitDirectory
      || (canonicalGitDirectory !== canonicalCheckout
        && !canonicalGitDirectory.startsWith(`${canonicalCheckout}${path.sep}`))) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' stores Git metadata outside its checkout. Detach it without --drop-local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_EXTERNAL_GIT_DIR' }
    );
  }
  const retainedModules = await readdir(path.join(canonicalGitDirectory, 'modules')).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  if (retainedModules.length) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' retains submodule Git data under .git/modules. Deinitialize and remove or preserve that data explicitly before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_SUBMODULE' }
    );
  }
  const graftsPath = path.join(canonicalGitDirectory, 'info', 'grafts');
  const grafts = await workspaceDropLstat(graftsPath);
  if (grafts && (!grafts.isFile() || grafts.isSymbolicLink() || grafts.size > 0)) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' has a local Git graft map that can rewrite commit ancestry. Remove or preserve it before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_GIT_GRAPH_OVERRIDE' }
    );
  }
  const operationStatePaths = [
    'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'AUTO_MERGE',
    'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_LOG', 'BISECT_START', 'BISECT_NAMES'
  ];
  const operationStates = [];
  for (const relative of operationStatePaths) {
    if (await workspaceDropLstat(path.join(canonicalGitDirectory, relative))) {
      operationStates.push(relative);
    }
  }
  if (operationStates.length) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' has an unfinished Git operation (${operationStates.join(', ')}). Complete or abort it before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_GIT_OPERATION' }
    );
  }
  const writerLocks = await gitWriterLocks(canonicalGitDirectory);
  if (writerLocks.length) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' has an active Git writer lock (${writerLocks.join(', ')}). Wait for the Git operation to finish, then preview Detach & drop local again.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_GIT_BUSY' }
    );
  }
  const localLfsObjects = await readdir(path.join(canonicalGitDirectory, 'lfs', 'objects')).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  if (localLfsObjects.length) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' contains local Git LFS objects whose remote publication cannot be proven by ordinary Git refs. Detach it without --drop-local, or remove the checkout manually after verifying LFS publication.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_LFS_UNVERIFIED' }
    );
  }
  const configuredLfs = run('git', ['config', '--path', '--get', 'lfs.storage'], {
    cwd: target, env: gitEnv, allowFailure: true
  });
  if (![0, 1].includes(configuredLfs.status)) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' configured Git LFS storage could not be verified. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  if (configuredLfs.status === 0 && configuredLfs.stdout.trim()) {
    const configuredPath = configuredLfs.stdout.trim();
    const storage = path.resolve(canonicalGitDirectory, configuredPath);
    const insideCheckout = storage === canonicalCheckout
      || storage.startsWith(`${canonicalCheckout}${path.sep}`);
    const retainedStorage = insideCheckout
      ? await readdir(storage).catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      })
      : [];
    if (retainedStorage.length) {
      throw new SingularityFlowError(
        `Repository '${repository.id}' contains configured Git LFS storage inside its checkout whose remote publication cannot be proven. Detach it without --drop-local, or verify and remove the checkout manually.`,
        { code: 'WORKSPACE_CAPABILITY_DROP_LFS_UNVERIFIED' }
      );
    }
  }
  const worktrees = run('git', ['worktree', 'list', '--porcelain'], {
    cwd: target, env: gitEnv, allowFailure: true
  });
  if (worktrees.status !== 0) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' linked worktrees could not be verified. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  const linked = worktrees.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length).trim()));
  const canonicalTarget = await realpath(target);
  if (linked.length !== 1
      || (await realpath(linked[0]).catch(() => linked[0])) !== canonicalTarget) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' has another linked worktree. Remove or relocate that worktree before dropping the workspace checkout.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_LINKED_WORKTREE' }
    );
  }
  const unpublished = run('git', [
    'rev-list', '--max-count=1', 'HEAD', '--all', '--not', '--remotes=origin', '--tags'
  ], { cwd: target, env: gitEnv, allowFailure: true });
  if (unpublished.status !== 0) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' local commit reachability could not be verified. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  if (unpublished.stdout.trim()) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' contains local refs (a branch, tag, or stash) with commits that are not present on any remote-tracking branch. Push or preserve them outside this checkout before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNPUSHED' }
    );
  }
  const reflogOnly = run('git', [
    'rev-list', '--max-count=1', '--reflog', '--not', '--remotes=origin', '--tags'
  ], { cwd: target, env: gitEnv, allowFailure: true });
  if (reflogOnly.status !== 0) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' reflog reachability could not be verified. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  if (reflogOnly.stdout.trim()) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' contains commits retained only by local refs or reflogs and absent from remote-tracking branches. Push or preserve them before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNPUSHED' }
    );
  }
  const unreachable = run('git', [
    'fsck', '--unreachable', '--no-reflogs', '--no-progress', '--no-dangling'
  ], { cwd: target, env: gitEnv, allowFailure: true });
  if (unreachable.status !== 0) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' unreachable Git object safety could not be verified. Nothing was dropped.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  if (/\bunreachable\s+(?:blob|commit|tag|tree)\s+[0-9a-f]{40,64}\b/i.test(unreachable.stdout)) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' contains unreachable Git objects that may retain local work. Preserve or remove them explicitly before using Detach & drop local.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNPUSHED' }
    );
  }
  const refsSha256 = await workspaceRepositoryReferenceProof(repository, target, { env: gitEnv });
  return {
    id: repository.id,
    path: target,
    state: 'ready',
    head: observedHead,
    worktreeSha256: fingerprint.sha256,
    refsSha256,
    directoryIdentity: dropDirectoryIdentity(info),
    removable: true
  };
}

function approvedCapabilityIds(nodes, into = new Set()) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.id) into.add(String(node.id));
    approvedCapabilityIds(node?.children, into);
  }
  return into;
}

function mergeRequiredRepositoryPlans(base, addition) {
  const repositories = { ...(base?.repositories ?? {}) };
  for (const [id, repository] of Object.entries(addition?.repositories ?? {})) {
    const current = repositories[id];
    repositories[id] = current ? {
      ...current,
      capabilities: [...new Set([
        ...(current.capabilities ?? []), ...(repository.capabilities ?? [])
      ])].sort()
    } : repository;
  }
  return { repositories };
}

/**
 * Preview one local workspace capability transition.
 *
 * The approved organisation map remains the source of repository URLs and capability closure.
 * Detach keeps unneeded checkouts registered but unbound; drop removes only repositories that are
 * no longer needed by another selected capability, and never removes the lead repository.
 */
export async function previewWorkspaceCapabilityChange(workspacePath, capabilityId, {
  action = 'attach',
  dropLocal = false,
  organisation: suppliedOrganisation = null,
  readOrganisationOperation = null,
  resolveWorkspacePlanOperation = null,
  dropProofOperation = workspaceRepositoryDropProof
} = {}) {
  if (!['attach', 'detach'].includes(action)) {
    throw new SingularityFlowError(`Unknown workspace capability action '${action}'.`);
  }
  if (dropLocal && action !== 'detach') {
    throw new SingularityFlowError('--drop-local is available only when detaching a capability.');
  }
  const id = String(capabilityId ?? '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new SingularityFlowError('Workspace capability must be a lower-case kebab-case identifier.');
  }
  const current = await readWorkspace(workspacePath);
  const authorityUrl = workspaceCapabilityAuthority(current);
  if (!authorityUrl) {
    throw new SingularityFlowError(
      `Workspace '${current.name}' has no capability authority. Repair its lead repository before changing capability attachments.`,
      { code: 'WORKSPACE_CAPABILITY_CATALOG_UNAVAILABLE' }
    );
  }
  let readOrganisation = readOrganisationOperation;
  let resolveWorkspacePlan = resolveWorkspacePlanOperation;
  if (!readOrganisation || !resolveWorkspacePlan) {
    const organisationModule = await import('./organisation.mjs');
    readOrganisation ??= organisationModule.readOrganisation;
    resolveWorkspacePlan ??= organisationModule.resolveWorkspacePlan;
  }
  // readOrganisation always re-observes the approved ref. Its commit-validated cache avoids a
  // second disposable configuration clone when preview and apply run back to back.
  const organisation = suppliedOrganisation ?? await readOrganisation(authorityUrl, { refresh: false });
  if (organisation?.stale) {
    throw new SingularityFlowError(
      'The approved capability authority is unreachable, so only a stale cached map is available. Nothing was changed; restore Git access and preview again.',
      { code: 'WORKSPACE_CAPABILITY_AUTHORITY_STALE' }
    );
  }
  const authorityConfigurationBranch = String(
    organisation?.configurationBranch ?? organisation?.branch ?? 'sflow/config'
  ).trim();
  const authorityConfigurationCommit = String(
    organisation?.configurationCommit
      ?? (organisation?.sourceBranch === authorityConfigurationBranch
        ? organisation?.sourceCommit : '')
  ).trim();
  const authoritySourceBranch = String(
    organisation?.sourceBranch ?? authorityConfigurationBranch
  ).trim();
  const authoritySourceCommit = String(organisation?.sourceCommit ?? '').trim();
  if (!isGitRefName(authorityConfigurationBranch)
      || !/^[0-9a-f]{40,64}$/i.test(authorityConfigurationCommit)
      || !isGitRefName(authoritySourceBranch)
      || !/^[0-9a-f]{40,64}$/i.test(authoritySourceCommit)) {
    throw new SingularityFlowError(
      'The approved capability map is not bound to an exact readable Git revision. Nothing was changed; refresh the organisation map and retry.',
      { code: 'WORKSPACE_CAPABILITY_AUTHORITY_UNBOUND' }
    );
  }
  if (organisation?.url
      && storableRemote(organisation.url) !== storableRemote(authorityUrl)) {
    throw new SingularityFlowError(
      'The resolved capability map belongs to a different authority repository. Nothing was changed.',
      { code: 'WORKSPACE_CAPABILITY_AUTHORITY_MISMATCH' }
    );
  }
  const before = [...new Set(current.capabilities ?? [])].sort();
  const selected = new Set(before);
  const selectionChanged = action === 'attach' ? !selected.has(id) : selected.has(id);
  const knownCapabilities = approvedCapabilityIds(organisation?.capabilities);
  let detachedCapabilityPlan;
  if (knownCapabilities.has(id)) {
    detachedCapabilityPlan = resolveWorkspacePlan(organisation, { capabilities: [id] });
  } else if (action === 'attach') {
    // Preserve the resolver's authoritative unknown-capability diagnostic.
    detachedCapabilityPlan = resolveWorkspacePlan(organisation, { capabilities: [id] });
  } else if (dropLocal && selected.has(id)) {
    throw new SingularityFlowError(
      `Capability '${id}' is no longer present in the approved map. Detach it without --drop-local; local checkout removal requires a current approved repository mapping.`,
      { code: 'WORKSPACE_CAPABILITY_RETIRED_DROP_REFUSED' }
    );
  } else {
    // A retired/renamed capability must remain removable from local selection. Its persisted
    // bindings are evidence only for a non-destructive detach; they never authorize local deletion.
    detachedCapabilityPlan = {
      repositories: Object.fromEntries(Object.entries(current.repositories)
        .filter(([, repository]) => (repository.capabilities ?? []).includes(id)))
    };
  }
  if (action === 'attach') selected.add(id);
  else selected.delete(id);
  const after = [...selected].sort();
  const knownAfter = after.filter((capability) => knownCapabilities.has(capability));
  let required = knownAfter.length
    ? resolveWorkspacePlan(organisation, { capabilities: knownAfter })
    : { repositories: {} };
  for (const retired of after.filter((capability) => !knownCapabilities.has(capability))) {
    required = mergeRequiredRepositoryPlans(required, {
      repositories: Object.fromEntries(Object.entries(current.repositories)
        .filter(([, repository]) => (repository.capabilities ?? []).includes(retired))
        .map(([repositoryId, repository]) => [repositoryId, {
          ...repository,
          capabilities: (repository.capabilities ?? []).filter((capability) => capability === retired)
        }]))
    });
  }

  const repositories = Object.fromEntries(Object.entries(current.repositories).map(([repositoryId, repository]) => [
    repositoryId, { ...repository, capabilities: [] }
  ]));
  for (const [repositoryId, approved] of Object.entries(required.repositories ?? {})) {
    const existing = repositories[repositoryId];
    if (existing) {
      if (existing.url !== approved.url || existing.defaultBranch !== approved.defaultBranch) {
        throw new SingularityFlowError(
          `Workspace repository '${repositoryId}' no longer matches the approved capability map. Refresh or repair the workspace before changing capability attachments.`,
          { code: 'WORKSPACE_CAPABILITY_REPOSITORY_MISMATCH' }
        );
      }
      repositories[repositoryId] = {
        ...existing,
        capabilities: [...new Set(approved.capabilities ?? [])].sort()
      };
    } else {
      repositories[repositoryId] = approved;
    }
  }

  const requiredIds = new Set(Object.keys(required.repositories ?? {}));
  const capabilityRepositoryIds = new Set(Object.keys(detachedCapabilityPlan.repositories ?? {}));
  const dropIds = action === 'detach' && dropLocal
    ? [...capabilityRepositoryIds]
      .filter((repositoryId) => !requiredIds.has(repositoryId)
        && repositoryId !== current.leadRepository
        && current.repositories[repositoryId])
      .sort()
    : [];
  if (dropIds.length) {
    assertWorkspaceCapabilityDropNamespace(dropIds);
    assertWorkspaceCapabilityDropPathsIsolated(current, dropIds.map((repositoryId) => ({
      id: repositoryId,
      path: workspaceRepositoryPath(current, current.repositories[repositoryId])
    })));
  }
  for (const repositoryId of dropIds) delete repositories[repositoryId];

  const manifest = validateWorkspaceManifest({
    ...current,
    capabilities: after,
    repositories,
    updatedAt: nowIso()
  }, { workspaceRoot: current.path });
  const changed = selectionChanged
    || workspaceCapabilityTargetSha256(manifest) !== workspaceCapabilityTargetSha256(current);
  const sourceManifestSha256 = workspaceCapabilityChangeSha256(current);
  const addedRepositories = Object.keys(repositories)
    .filter((repositoryId) => !current.repositories[repositoryId]).sort();
  for (const repositoryId of addedRepositories) {
    const target = workspaceRepositoryPath(manifest, manifest.repositories[repositoryId]);
    if (await lstat(target).catch(() => null)) {
      throw new SingularityFlowError(
        `Repository '${repositoryId}' already has an unregistered local path at ${target}. Nothing was changed. Adopt or move that checkout explicitly before attaching this capability.`,
        { code: 'WORKSPACE_CAPABILITY_TARGET_EXISTS' }
      );
    }
  }
  const dropGitEnv = dropIds.length ? workspaceDropGitEnvironment() : null;
  const status = dropIds.length || action === 'attach'
    ? await workspaceStatus(current.path, {
      level: 'summary', env: dropGitEnv ?? process.env
    }) : null;
  let archiveReadiness = null;
  if (dropIds.length) {
    // Local remote-tracking refs are not publication evidence until they have been refreshed. A
    // bounded fetch/prune of only the deletion candidates prevents a force-pushed or deleted remote
    // branch from turning the last local copy into apparently safe disposable data.
    const presentDropIds = dropIds.filter((repositoryId) =>
      status?.repositories.find((repository) => repository.id === repositoryId)?.state === 'ready');
    for (const repositoryId of presentDropIds) {
      await assertWorkspaceDropLocalGitConfiguration(
        current.repositories[repositoryId],
        workspaceRepositoryPath(current, current.repositories[repositoryId]),
        { env: dropGitEnv }
      );
    }
    archiveReadiness = await workspaceArchiveReadiness(current.path, {
      fetch: true, status, repositoryIds: presentDropIds, env: dropGitEnv
    });
    const active = archiveReadiness.activeStories.filter((story) => dropIds.includes(story.repository));
    if (active.length) {
      throw new SingularityFlowError(
        `Cannot drop local repository checkout${dropIds.length === 1 ? '' : 's'} while governed work is active: `
          + active.map((story) => `${story.id} in ${story.repository} is ${story.status}`).join('; '),
        { code: 'WORKSPACE_CAPABILITY_DROP_ACTIVE_STORY', details: { activeStories: active } }
      );
    }
    const candidateBlockers = archiveReadiness.blockers.filter((message) =>
      dropIds.some((repositoryId) => message.includes(`Repository '${repositoryId}'`)));
    if (candidateBlockers.length) {
      throw new SingularityFlowError(
        `Cannot prove local drop safety: ${candidateBlockers.join(' | ')}`,
        { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
      );
    }
  }
  const dropRepositories = [];
  for (const repositoryId of dropIds) {
    const repositoryStatus = status?.repositories.find((entry) => entry.id === repositoryId);
    dropRepositories.push(await dropProofOperation(
      current, current.repositories[repositoryId], repositoryStatus, { env: dropGitEnv }
    ));
  }
  const materializeRepositories = action === 'attach'
    ? [...capabilityRepositoryIds].filter((repositoryId) => {
        if (addedRepositories.includes(repositoryId)) return true;
        return status?.repositories.find((repository) => repository.id === repositoryId)?.state !== 'ready';
      }).sort()
    : [];
  const materializationStates = Object.fromEntries(materializeRepositories.map((repositoryId) => [
    repositoryId,
    addedRepositories.includes(repositoryId)
      ? 'missing'
      : status?.repositories.find((repository) => repository.id === repositoryId)?.state ?? 'missing'
  ]));
  const planPayload = {
    action,
    capabilityId: id,
    dropLocal,
    workspace: { id: current.id, path: current.path },
    authority: {
      url: authorityUrl,
      configurationBranch: authorityConfigurationBranch,
      configurationCommit: authorityConfigurationCommit,
      sourceBranch: authoritySourceBranch,
      sourceCommit: authoritySourceCommit
    },
    sourceManifestSha256,
    selectedBefore: before,
    selectedAfter: after,
    addedRepositories,
    materializeRepositories,
    materializationStates,
    requestedRepositoryIds: [...capabilityRepositoryIds].sort(),
    droppedRepositories: dropRepositories.map(({
      id: repositoryId, head, worktreeSha256, refsSha256, directoryIdentity, state, removable
    }) => ({
      id: repositoryId,
      relativePath: current.repositories[repositoryId].path,
      url: current.repositories[repositoryId].url,
      defaultBranch: current.repositories[repositoryId].defaultBranch,
      head, worktreeSha256, refsSha256, directoryIdentity, state, removable
    })),
    targetManifestSha256: workspaceCapabilityTargetSha256(manifest)
  };
  const planId = `wscp-${workspaceCapabilityChangeSha256(planPayload).slice('sha256:'.length, 'sha256:'.length + 24)}`;
  return {
    schemaVersion: 1, // schema-transient: exact workspace capability preview, never persisted
    planId,
    changed,
    action,
    capabilityId: id,
    dropLocal,
    workspace: planPayload.workspace,
    authority: planPayload.authority,
    selectedBefore: before,
    selectedAfter: after,
    addedRepositories,
    materializeRepositories,
    materializationStates,
    requestedRepositoryIds: planPayload.requestedRepositoryIds,
    dropRepositories,
    preservedRepositories: Object.keys(repositories).sort(),
    preservedLeadRepository: dropLocal && capabilityRepositoryIds.has(current.leadRepository)
      && !requiredIds.has(current.leadRepository) ? current.leadRepository : null,
    sourceManifestSha256,
    plan: planPayload,
    manifest
  };
}

/** Apply an exact previewed capability transition and materialize only newly required clones. */
export async function changeWorkspaceCapability(workspacePath, capabilityId, options = {}, {
  confirmation = null
} = {}) {
  await recoverWorkspaceCapabilityDropTransactions(workspacePath);
  // Apply never accepts a caller-supplied organisation projection. Preview injection exists only
  // for read-only callers; persisted bytes are always recomputed from the live approved authority.
  const preview = await previewWorkspaceCapabilityChange(workspacePath, capabilityId, {
    action: options?.action ?? 'attach',
    dropLocal: options?.dropLocal === true
  });
  if (confirmation !== preview.planId) {
    throw new SingularityFlowError(
      `Workspace capability change requires exact plan confirmation '${preview.planId}'. Preview again if the workspace or repository changed.`,
      { code: 'WORKSPACE_CAPABILITY_CONFIRMATION_REQUIRED', details: { plan: preview } }
    );
  }
  if (!preview.changed) {
    let repaired = { repaired: [], status: await workspaceStatus(workspacePath) };
    let materializationError = null;
    if (preview.action === 'attach') {
      const manifestFile = path.join(preview.workspace.path, WORKSPACE_FILE);
      await withRegistryFileLease(manifestFile, async () => {
        const current = await readWorkspace(preview.workspace.path);
        if (workspaceCapabilityChangeSha256(current) !== preview.sourceManifestSha256) {
          throw new SingularityFlowError(
            'Workspace configuration changed after the capability preview. Nothing was changed; create a fresh preview.',
            { code: 'WORKSPACE_CAPABILITY_PLAN_STALE' }
          );
        }
      });
      ({ repaired, materializationError } = await repairWorkspaceCapabilityAttachment(
        preview.workspace.path, {
          recoverCapabilityDrops: false,
          repositoryIds: preview.requestedRepositoryIds,
          expectedMissingRepositoryIds: preview.materializeRepositories
        }
      ));
    }
    return {
      changed: false,
      planId: preview.planId,
      workspace: repaired.status.workspace,
      status: repaired.status,
      repair: repaired.repaired,
      materializationError,
      repairCommand: materializationError
        ? `singularity-flow workspace repair ${JSON.stringify(preview.workspace.path)}` : null,
      dropped: [],
      retained: [],
      removedRepositoryIds: []
    };
  }
  const manifestFile = path.join(preview.workspace.path, WORKSPACE_FILE);
  const staged = [];
  const dropped = [];
  const retained = [];
  let dropRoot = null;
  let attachmentRepair = null;
  await withRegistryFileLease(manifestFile, async () => {
    await assertWorkspaceCapabilityAuthorityCurrent(preview.authority);
    const current = await readWorkspace(preview.workspace.path);
    if (workspaceCapabilityChangeSha256(current) !== preview.sourceManifestSha256) {
      throw new SingularityFlowError(
        'Workspace configuration changed after the capability preview. Nothing was changed; create a fresh preview.',
        { code: 'WORKSPACE_CAPABILITY_PLAN_STALE' }
      );
    }
    if (preview.dropRepositories.length) {
      const candidates = preview.dropRepositories.map(({ id }) => ({
        id,
        path: workspaceRepositoryPath(current, current.repositories[id])
      }));
      assertWorkspaceCapabilityDropNamespace(candidates.map(({ id }) => id));
      assertWorkspaceCapabilityDropPathsIsolated(current, candidates);
    }
    if (preview.action === 'attach' && preview.materializeRepositories.length) {
      const materializationStatus = await workspaceStatus(current.path, { level: 'summary' });
      for (const repositoryId of preview.materializeRepositories) {
        const actualState = materializationStatus.repositories
          .find((repository) => repository.id === repositoryId)?.state ?? 'missing';
        const expectedState = preview.materializationStates?.[repositoryId] ?? 'missing';
        if (actualState !== expectedState) {
          throw new SingularityFlowError(
            `Repository '${repositoryId}' local target changed from ${expectedState} to ${actualState} after preview. Nothing was claimed; inspect it and preview again.`,
            { code: 'WORKSPACE_CAPABILITY_PLAN_STALE' }
          );
        }
      }
    }
    if (!preview.dropRepositories.some((repository) => repository.removable)) {
      for (const planned of preview.dropRepositories) {
        const repository = current.repositories[planned.id];
        const target = workspaceRepositoryPath(current, repository);
        const targetInfo = await workspaceDropLstat(target);
        if (planned.state !== 'missing' || targetInfo) {
          throw new SingularityFlowError(
            `Repository '${planned.id}' local target changed after preview. Nothing was detached; inspect it and preview again.`,
            { code: 'WORKSPACE_CAPABILITY_PLAN_STALE' }
          );
        }
      }
      for (const repositoryId of preview.addedRepositories) {
        const target = workspaceRepositoryPath(preview.manifest, preview.manifest.repositories[repositoryId]);
        if (await workspaceDropLstat(target)) {
          throw new SingularityFlowError(
            `Repository '${repositoryId}' local target appeared after preview. Nothing was changed; inspect ${target} and preview again.`,
            { code: 'WORKSPACE_CAPABILITY_PLAN_STALE' }
          );
        }
      }
      await atomicJson(manifestFile, preview.manifest);
      return;
    }

    // Re-run every local safety proof while the workspace capability lease is held. A concurrent
    // attach/detach cannot cross this section, and the atomic rename below makes the checkout
    // unavailable before the manifest stops naming it.
    const dropGitEnv = workspaceDropGitEnvironment();
    const currentStatus = await workspaceStatus(current.path, {
      level: 'summary', env: dropGitEnv
    });
    const candidateIds = preview.dropRepositories.map((repository) => repository.id);
    const presentCandidateIds = candidateIds.filter((repositoryId) =>
      currentStatus.repositories.find((repository) => repository.id === repositoryId)?.state === 'ready');
    for (const repositoryId of presentCandidateIds) {
      await assertWorkspaceDropLocalGitConfiguration(
        current.repositories[repositoryId],
        workspaceRepositoryPath(current, current.repositories[repositoryId]),
        { env: dropGitEnv }
      );
    }
    const readiness = await workspaceArchiveReadiness(current.path, {
      fetch: true, status: currentStatus, repositoryIds: presentCandidateIds,
      env: dropGitEnv
    });
    const active = readiness.activeStories.filter((story) => candidateIds.includes(story.repository));
    if (active.length) {
      throw new SingularityFlowError(
        `Governed work became active after preview: ${active.map((story) => `${story.id} in ${story.repository}`).join(', ')}. Nothing was dropped.`,
        { code: 'WORKSPACE_CAPABILITY_PLAN_STALE' }
      );
    }
    const candidateBlockers = readiness.blockers.filter((message) =>
      candidateIds.some((repositoryId) => message.includes(`Repository '${repositoryId}'`)));
    if (candidateBlockers.length) {
      throw new SingularityFlowError(
        `Local drop safety changed after preview: ${candidateBlockers.join(' | ')}. Nothing was dropped.`,
        { code: 'WORKSPACE_CAPABILITY_PLAN_STALE' }
      );
    }
    const currentProofs = [];
    for (const planned of preview.dropRepositories) {
      const repository = current.repositories[planned.id];
      const repositoryStatus = currentStatus.repositories.find((entry) => entry.id === planned.id);
      const proof = await workspaceRepositoryDropProof(current, repository, repositoryStatus, {
        env: dropGitEnv
      });
      if (proof.state !== planned.state || proof.head !== planned.head
          || proof.worktreeSha256 !== planned.worktreeSha256
          || proof.refsSha256 !== planned.refsSha256
          || !equalDropDirectoryIdentity(proof.directoryIdentity, planned.directoryIdentity)
          || proof.removable !== planned.removable) {
        throw new SingularityFlowError(
          `Repository '${planned.id}' changed after preview. Nothing was dropped; create a fresh preview.`,
          { code: 'WORKSPACE_CAPABILITY_PLAN_STALE' }
        );
      }
      currentProofs.push(proof);
    }

    assertWorkspaceCapabilityDropPathsIsolated(current, currentProofs.map((proof) => ({
      id: proof.id, path: proof.path
    })));

    dropRoot = path.join(current.path, '.singularity-flow', 'workspace-capability-drop', preview.planId);
    await assertInside(current.path, dropRoot);
    if (await workspaceDropLstat(dropRoot)) {
      throw new SingularityFlowError(
        `A retained local-drop transaction already exists for ${preview.planId}. Run singularity-flow workspace repair ${JSON.stringify(current.path)} before retrying.`,
        { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_REQUIRED' }
      );
    }
    await mkdir(dropRoot, { recursive: true });
    const transactionFile = path.join(dropRoot, 'transaction.json');
    const transaction = sealWorkspaceCapabilityDropTransaction({
      schemaVersion: WORKSPACE_CAPABILITY_DROP_SCHEMA_VERSION,
      format: 'workspace-capability-drop-v1',
      planId: preview.planId,
      phase: 'prepared',
      workspace: current.path,
      sourceManifestSha256: preview.sourceManifestSha256,
      targetManifestSha256: workspaceCapabilityTargetSha256(preview.manifest),
      plan: preview.plan,
      repositories: currentProofs.map((proof) => ({
        id: proof.id,
        relativePath: current.repositories[proof.id].path,
        url: current.repositories[proof.id].url,
        defaultBranch: current.repositories[proof.id].defaultBranch,
        state: proof.state,
        removable: proof.removable,
        source: proof.path,
        staged: path.join(dropRoot, proof.id),
        head: proof.head,
        worktreeSha256: proof.worktreeSha256,
        refsSha256: proof.refsSha256 ?? null,
        directoryIdentity: proof.directoryIdentity ?? null,
        stagedIdentity: proof.directoryIdentity ?? null
      }))
    });
    await atomicJson(transactionFile, transaction);
    try {
      for (const proof of currentProofs) {
        if (!proof.removable) continue;
        const target = path.join(dropRoot, proof.id);
        await assertInside(current.path, target);
        await rename(proof.path, target);
        const repository = current.repositories[proof.id];
        const stagedIdentity = dropDirectoryIdentity(await lstat(target, { bigint: true }));
        staged.push({ id: proof.id, source: proof.path, target, repository, proof, stagedIdentity });
        if (!sameDropDirectoryIdentity(proof.directoryIdentity, stagedIdentity)) {
          throw new SingularityFlowError(
            `Repository '${proof.id}' checkout identity changed between safety proof and staging. Nothing was deleted.`,
            { code: 'WORKSPACE_CAPABILITY_PLAN_STALE' }
          );
        }
      }
      const stagedTransaction = sealWorkspaceCapabilityDropTransaction({
        ...transaction,
        phase: 'staged',
        repositories: transaction.repositories.map((repository) => ({
          ...repository,
          stagedIdentity: staged.find((item) => item.id === repository.id)?.stagedIdentity ?? null
        }))
      });
      await atomicJson(transactionFile, stagedTransaction);
      await atomicJson(manifestFile, preview.manifest);
      await atomicJson(transactionFile, sealWorkspaceCapabilityDropTransaction({
        ...stagedTransaction, phase: 'manifest-updated'
      }));
    } catch (error) {
      const persisted = await readWorkspace(preview.workspace.path).catch(() => null);
      const manifestUpdated = persisted
        && workspaceCapabilityTargetSha256(persisted)
          === workspaceCapabilityTargetSha256(preview.manifest);
      if (!manifestUpdated) {
        for (const repository of [...staged].reverse()) {
          await rename(repository.target, repository.source).catch(() => {});
        }
      }
      throw error;
    }
    // Keep finalization under the same manifest lease used by staging. Recovery takes this exact
    // lease as well, so it can never race the live command over a transaction or retained checkout.
    if (dropRoot) {
      const finalized = await finalizeWorkspaceCapabilityDropTransaction(
        preview.manifest, dropRoot, staged
      );
      dropped.push(...finalized.dropped);
      retained.push(...finalized.retained);
    }
  });

  if (preview.action === 'attach') {
    attachmentRepair = await repairWorkspaceCapabilityAttachment(preview.workspace.path, {
      recoverCapabilityDrops: false,
      repositoryIds: preview.requestedRepositoryIds,
      expectedMissingRepositoryIds: preview.materializeRepositories
    });
  }

  const repaired = attachmentRepair?.repaired
    ? attachmentRepair
    : { repaired: [], status: await workspaceStatus(preview.workspace.path) };
  const materializationError = attachmentRepair?.materializationError ?? null;
  return {
    changed: true,
    planId: preview.planId,
    workspace: repaired.status.workspace,
    status: repaired.status,
    repair: repaired.repaired,
    materializationError,
    repairCommand: materializationError || retained.length
      ? `singularity-flow workspace repair ${JSON.stringify(preview.workspace.path)}` : null,
    dropped,
    retained,
    removedRepositoryIds: preview.dropRepositories.map((repository) => repository.id),
    preservedLeadRepository: preview.preservedLeadRepository
  };
}

async function assertWorkspaceCapabilityAuthorityCurrent(authority) {
  const configurationBranch = String(authority?.configurationBranch ?? '').trim();
  const configurationCommit = String(authority?.configurationCommit ?? '').trim();
  const sourceBranch = String(authority?.sourceBranch ?? '').trim();
  const sourceCommit = String(authority?.sourceCommit ?? '').trim();
  if (!authority?.url
      || !isGitRefName(configurationBranch)
      || !/^[0-9a-f]{40,64}$/i.test(configurationCommit)
      || !isGitRefName(sourceBranch)
      || !/^[0-9a-f]{40,64}$/i.test(sourceCommit)) {
    throw new SingularityFlowError(
      'The capability transition is not bound to an exact approved authority revision. Preview again.',
      { code: 'WORKSPACE_CAPABILITY_AUTHORITY_UNBOUND' }
    );
  }
  const env = enterpriseGitEnvironment();
  const session = new GitRemoteSession({ env });
  const refs = [...new Set([
    `refs/heads/${configurationBranch}`, `refs/heads/${sourceBranch}`
  ])];
  const observation = await session.observeAsync(authority.url, {
    includeHead: false, refs
  });
  requireRemoteObservation(observation, 'workspace capability authority');
  const actualConfiguration = observation.refs.get(`refs/heads/${configurationBranch}`) ?? null;
  const actualSource = observation.refs.get(`refs/heads/${sourceBranch}`) ?? null;
  if (actualConfiguration !== configurationCommit || actualSource !== sourceCommit) {
    throw new SingularityFlowError(
      `The approved capability authority moved after preview (${configurationCommit.slice(0, 12)} -> ${actualConfiguration?.slice(0, 12) ?? 'missing'}). Nothing was changed; create a fresh preview.`,
      {
        code: 'WORKSPACE_CAPABILITY_PLAN_STALE',
        details: {
          configurationBranch,
          expectedConfigurationCommit: configurationCommit,
          actualConfigurationCommit: actualConfiguration,
          sourceBranch,
          expectedSourceCommit: sourceCommit,
          actualSourceCommit: actualSource
        }
      }
    );
  }
}

async function repairWorkspaceCapabilityAttachment(workspacePath, options = {}) {
  try {
    const repaired = await repairWorkspace(workspacePath, options);
    return { ...repaired, materializationError: null };
  } catch (error) {
    return {
      repaired: [],
      status: await workspaceStatus(workspacePath),
      materializationError: error?.message || String(error)
    };
  }
}

async function assertDropTransactionChildren(directory, repositoryIds) {
  assertWorkspaceCapabilityDropNamespace(repositoryIds, {
    code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
  });
  const allowed = new Set([
    'transaction.json',
    ...repositoryIds,
    ...repositoryIds.map((id) => `${id}.deleting`)
  ]);
  const entries = await readdir(directory, { withFileTypes: true });
  const unexpected = entries.filter((entry) => !allowed.has(entry.name));
  if (unexpected.length) {
    throw new SingularityFlowError(
      `Local-drop transaction contains unrecognized path${unexpected.length === 1 ? '' : 's'}: ${unexpected.map((entry) => entry.name).join(', ')}. Nothing in the retained transaction was deleted.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
    );
  }
  const receipt = entries.find((entry) => entry.name === 'transaction.json');
  if (!receipt?.isFile() || receipt.isSymbolicLink()) {
    throw new SingularityFlowError(
      'Local-drop transaction receipt is missing or is not a regular file. Nothing was deleted.',
      { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
    );
  }
  return entries;
}

async function refreshStagedDropOrigin(repository, target, {
  env = enterpriseGitEnvironment()
} = {}) {
  await assertWorkspaceDropLocalGitConfiguration(repository, target, { env });
  if (!prepareRemoteBranchTracking(target, 'origin', { env })) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' has no origin remote. Retained local-drop data was not deleted.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
  const transport = frozenRemoteTransport(repository.url, { env });
  const refreshed = await runRemoteGitAsync([
    'fetch', '--prune', transport.remote, '+refs/heads/*:refs/remotes/origin/*'
  ], { cwd: target, operation: 'remote-configuration', env: transport.env });
  if (refreshed.status !== 0) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' could not refresh its reviewed origin before retained data deletion. ${refreshed.failure?.advice ?? 'Restore Git access and retry.'}`,
      { code: 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED' }
    );
  }
}

async function verifyStagedDropRepository(workspace, repository, recorded, {
  refreshOrigin = false,
  env = null
} = {}) {
  const gitEnv = workspaceDropGitEnvironment(env);
  await assertInside(workspace.path, recorded.staged);
  const info = await workspaceDropLstat(recorded.staged, { bigint: true });
  if (!info?.isDirectory() || info.isSymbolicLink()
      || !sameDropDirectoryIdentity(recorded.directoryIdentity, recorded.stagedIdentity)
      || !sameDropDirectoryIdentity(recorded.stagedIdentity, dropDirectoryIdentity(info))) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' retained checkout identity changed after staging. It was not deleted.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
    );
  }
  if (refreshOrigin) await refreshStagedDropOrigin(repository, recorded.staged, { env: gitEnv });
  const observedHead = gitValue(recorded.staged, ['rev-parse', 'HEAD'], { env: gitEnv });
  const proof = await workspaceRepositoryDropProof(workspace, repository, {
    state: 'ready', dirty: false, head: observedHead
  }, { targetPath: recorded.staged, env: gitEnv });
  if (proof.head !== recorded.head
      || proof.worktreeSha256 !== recorded.worktreeSha256
      || proof.refsSha256 !== recorded.refsSha256) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' changed after it was staged for local drop. Its retained checkout was not deleted.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
    );
  }
  return proof;
}

function removeDropRepositoryFromQuarantine(workspace, repository, quarantine, recorded) {
  const workspaceRoot = path.resolve(workspace.path);
  const resolvedQuarantine = path.resolve(quarantine);
  if (!resolvedQuarantine.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' final quarantine escaped its workspace. It was not deleted.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
    );
  }
  assertWorkspaceCapabilityDropPathsIsolated(workspace, [{
    id: repository.id, path: resolvedQuarantine
  }]);
  let quarantinedInfo = null;
  try { quarantinedInfo = lstatSync(resolvedQuarantine, { bigint: true }); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (!quarantinedInfo?.isDirectory() || quarantinedInfo.isSymbolicLink()
      || !sameDropDirectoryIdentity(
        recorded.stagedIdentity, dropDirectoryIdentity(quarantinedInfo)
      )) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' final quarantine identity did not match the proved checkout. It was not deleted.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
    );
  }
  // The final rename gives deletion a distinct transaction-owned path. Verify the moved inode
  // immediately before recursive removal without yielding the JS event loop between those two
  // operations; a replacement at the former staged path is never read.
  rmSync(resolvedQuarantine, { recursive: true });
}

async function finalizeStagedDropRepository(workspace, repository, recorded, {
  refreshOrigin = false,
  env = null
} = {}) {
  const gitEnv = workspaceDropGitEnvironment(env);
  assertWorkspaceCapabilityDropPathsIsolated(workspace, [{
    id: repository.id, path: recorded.staged
  }]);
  await verifyStagedDropRepository(workspace, repository, recorded, {
    refreshOrigin, env: gitEnv
  });
  const quarantine = `${recorded.staged}.deleting`;
  await assertInside(workspace.path, quarantine);
  if (await workspaceDropLstat(quarantine)) {
    throw new SingularityFlowError(
      `Repository '${repository.id}' final quarantine path already exists. Retained checkout data was not deleted.`,
      { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
    );
  }
  await rename(recorded.staged, quarantine);
  removeDropRepositoryFromQuarantine(workspace, repository, quarantine, recorded);
  return quarantine;
}

async function finalizeWorkspaceCapabilityDropTransaction(workspace, dropRoot, staged) {
  const dropped = [];
  const retained = [];
  let transaction = null;
  try {
    await assertInside(workspace.path, dropRoot);
    transaction = readRecord(
      'workspace-capability-drop-transaction',
      await readFile(path.join(dropRoot, 'transaction.json'))
    ).record;
    await assertDropTransactionChildren(
      dropRoot, transaction.repositories.map((item) => item.id)
    );
  } catch (error) {
    retained.push({
      id: 'transaction', path: dropRoot, recoveryPath: dropRoot,
      reason: error?.message || String(error)
    });
  }
  const gitEnv = workspaceDropGitEnvironment();
  for (const repository of staged) {
    if (retained.length) {
      retained.push({
        id: repository.id, path: repository.source, recoveryPath: repository.target,
        reason: 'The local-drop transaction requires repair before any retained checkout can be deleted.'
      });
      continue;
    }
    const recorded = {
      staged: repository.target,
      directoryIdentity: repository.proof.directoryIdentity,
      stagedIdentity: repository.stagedIdentity,
      head: repository.proof.head,
      worktreeSha256: repository.proof.worktreeSha256,
      refsSha256: repository.proof.refsSha256
    };
    try {
      await finalizeStagedDropRepository(workspace, repository.repository, recorded, {
        env: gitEnv
      });
      dropped.push({ id: repository.id, path: repository.source });
    } catch (error) {
      const quarantine = `${repository.target}.deleting`;
      const recoveryPath = await workspaceDropLstat(quarantine)
        ? quarantine : repository.target;
      retained.push({
        id: repository.id, path: repository.source, recoveryPath,
        reason: error?.message || String(error)
      });
    }
  }
  if (!retained.length) {
    try {
      await assertInside(workspace.path, dropRoot);
      if (!(await removeCompletedDropTransaction(dropRoot, transaction))) {
        retained.push({
          id: 'transaction', path: dropRoot, recoveryPath: dropRoot,
          reason: 'The checkout was safely dropped, but a concurrent path prevented transaction cleanup. Run workspace repair.'
        });
      }
    } catch (error) {
      retained.push({
        id: 'transaction', path: dropRoot, recoveryPath: dropRoot,
        reason: error?.message || String(error)
      });
    }
  }
  return { dropped, retained };
}

async function removeCompletedDropTransaction(directory, transaction) {
  const entries = await assertDropTransactionChildren(directory, []);
  if (entries.length !== 1) return false;
  const receipt = path.join(directory, 'transaction.json');
  await rm(receipt, { force: true });
  try {
    await rmdir(directory);
    return true;
  } catch {
    // A new entry may have appeared after the exact child check. Restore the receipt so the
    // transaction remains visible and recoverable; never recursively remove an unknown path.
    await atomicJson(receipt, transaction).catch(() => {});
    return false;
  }
}

/**
 * Recover only workspace-owned, hash-bound drop staging left by an interrupted local operation.
 * If the current manifest still names a repository, restore it; otherwise the already-detached
 * staging is the disposable side and can be removed. Unknown bytes are retained for inspection.
 */
async function recoverWorkspaceCapabilityDropTransactions(workspacePath) {
  const initial = await readWorkspace(workspacePath);
  const manifestFile = path.join(initial.path, WORKSPACE_FILE);
  await withRegistryFileLease(manifestFile, async () => {
    const workspace = await readWorkspace(initial.path);
    const dropGitEnv = workspaceDropGitEnvironment();
    const root = path.join(workspace.path, '.singularity-flow', 'workspace-capability-drop');
    try { await assertInside(workspace.path, root); }
    catch (error) {
      throw new SingularityFlowError(
        `Workspace capability-drop recovery root escaped its canonical workspace: ${error.message}`,
        { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
      );
    }
    const rootInfo = await workspaceDropLstat(root);
    if (rootInfo?.isSymbolicLink() || (rootInfo && !rootInfo.isDirectory())) {
      throw new SingularityFlowError(
        `Workspace capability-drop recovery root is not a regular directory: ${root}`,
        { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
      );
    }
    let transactions;
    try { transactions = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new SingularityFlowError(
        `Workspace capability-drop recovery cannot inspect ${root}: ${error.message}`,
        { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
      );
    }
    const recoveries = [];
    const blockers = [];
    for (const entry of transactions) {
      if (!/^wscp-[0-9a-f]{24}$/.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      try { await assertInside(workspace.path, directory); }
      catch (error) {
        blockers.push(`${directory}: recovery directory escaped its canonical workspace (${error.message})`);
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        blockers.push(`${directory}: transaction path is not a regular directory`);
        continue;
      }
      const file = path.join(directory, 'transaction.json');
      let transaction;
      try {
        transaction = readRecord(
          'workspace-capability-drop-transaction', await readFile(file)
        ).record;
      } catch (error) {
        blockers.push(`${file}: ${error.message}`);
        continue;
      }
      const planDigest = workspaceCapabilityChangeSha256(transaction?.plan ?? null);
      const derivedPlanId = `wscp-${planDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`;
      if (transaction?.format !== 'workspace-capability-drop-v1'
          || transaction?.planId !== entry.name
          || derivedPlanId !== entry.name
          || !validWorkspaceCapabilityDropTransactionSeal(transaction)
          || !['prepared', 'staged', 'manifest-updated'].includes(transaction?.phase)
          || transaction?.workspace !== workspace.path
          || transaction?.plan?.workspace?.path !== workspace.path
          || transaction?.plan?.action !== 'detach'
          || transaction?.plan?.dropLocal !== true
          || transaction?.plan?.sourceManifestSha256 !== transaction.sourceManifestSha256
          || transaction?.plan?.targetManifestSha256 !== transaction.targetManifestSha256
          || !Array.isArray(transaction.repositories)
          || !transaction.repositories.length
          || !Array.isArray(transaction?.plan?.droppedRepositories)) {
        blockers.push(`${file}: transaction identity or digest is invalid`);
        continue;
      }
      const recoveryMode = transaction.sourceManifestSha256
          === workspaceCapabilityChangeSha256(workspace)
        ? 'restore'
        : transaction.targetManifestSha256 === workspaceCapabilityTargetSha256(workspace)
          ? 'discard'
          : null;
      if (!recoveryMode) {
        blockers.push(`${file}: workspace manifest matches neither the recorded source nor target`);
        continue;
      }
      try {
        await assertDropTransactionChildren(
          directory,
          transaction.repositories.map((repository) => String(repository?.id ?? ''))
        );
      } catch (error) {
        blockers.push(`${file}: ${error.message}`);
        continue;
      }
      const plannedDrops = new Map(transaction.plan.droppedRepositories
        .map((repository) => [repository?.id, repository]));
      const candidates = [];
      let unsafe = null;
      const seen = new Set();
      for (const repository of transaction.repositories) {
        const id = String(repository?.id ?? '');
        const relativePath = String(repository?.relativePath ?? '');
        const source = path.resolve(String(repository?.source ?? ''));
        const staged = path.resolve(String(repository?.staged ?? ''));
        const quarantine = `${staged}.deleting`;
        const planned = plannedDrops.get(id);
        if (seen.has(id)
            || !planned
            || planned.relativePath !== relativePath
            || planned.url !== repository.url
            || planned.defaultBranch !== repository.defaultBranch
            || planned.head !== repository.head
            || planned.worktreeSha256 !== repository.worktreeSha256
            || planned.refsSha256 !== repository.refsSha256
            || planned.state !== repository.state
            || planned.removable !== repository.removable
            || !equalDropDirectoryIdentity(
              planned.directoryIdentity, repository.directoryIdentity
            )) {
          unsafe = `repository '${id || 'unknown'}' does not match the sealed plan`;
          break;
        }
        seen.add(id);
        let pathsCurrent = false;
        try {
          pathsCurrent = currentDropRecoveryPath(
            workspace, id, relativePath, source, staged, quarantine, directory
          );
        } catch { pathsCurrent = false; }
        try {
          await assertInside(workspace.path, source);
          await assertInside(workspace.path, staged);
          await assertInside(workspace.path, quarantine);
          await assertInside(workspace.path, directory);
        } catch {
          unsafe = `repository '${id || 'unknown'}' recovery path escaped its canonical workspace`;
          break;
        }
        let sourceInfo;
        let stagedInfo;
        let quarantineInfo;
        try {
          sourceInfo = await workspaceDropLstat(source, { bigint: true });
          stagedInfo = await workspaceDropLstat(staged, { bigint: true });
          quarantineInfo = await workspaceDropLstat(quarantine, { bigint: true });
        } catch (error) {
          unsafe = `repository '${id || 'unknown'}' recovery path could not be inspected (${error.message})`;
          break;
        }
        const presentPaths = [sourceInfo, stagedInfo, quarantineInfo].filter(Boolean).length;
        if (!pathsCurrent
            || (sourceInfo && (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()))
            || (stagedInfo && (stagedInfo.isSymbolicLink() || !stagedInfo.isDirectory()))
            || (quarantineInfo
              && (quarantineInfo.isSymbolicLink() || !quarantineInfo.isDirectory()))
            || presentPaths > 1) {
          unsafe = `repository '${id || 'unknown'}' has an unsafe or ambiguous recovery path`;
          break;
        }
        if (sourceInfo && repository.directoryIdentity
            && !sameDropDirectoryIdentity(
              repository.directoryIdentity, dropDirectoryIdentity(sourceInfo)
            )) {
          unsafe = `repository '${id}' source checkout identity changed`;
          break;
        }
        if (stagedInfo && (!sameDropDirectoryIdentity(
          repository.directoryIdentity, repository.stagedIdentity
        ) || !sameDropDirectoryIdentity(
          repository.stagedIdentity, dropDirectoryIdentity(stagedInfo)
        ))) {
          unsafe = `repository '${id}' staged checkout identity changed`;
          break;
        }
        if (quarantineInfo && (!sameDropDirectoryIdentity(
          repository.directoryIdentity, repository.stagedIdentity
        ) || !sameDropDirectoryIdentity(
          repository.stagedIdentity, dropDirectoryIdentity(quarantineInfo)
        ))) {
          unsafe = `repository '${id}' final quarantine identity changed`;
          break;
        }
        if (recoveryMode === 'restore' && !sourceInfo && !stagedInfo && !quarantineInfo) {
          if (planned.state !== 'missing') {
            unsafe = `repository '${id}' is absent from both its source and staging paths`;
            break;
          }
        }
        if (recoveryMode === 'discard' && sourceInfo) {
          unsafe = `repository '${id}' reappeared at its source path after detach`;
          break;
        }
        const observedPath = stagedInfo ? staged
          : quarantineInfo ? quarantine
            : sourceInfo ? source : null;
        if (observedPath) {
          if (!/^[0-9a-f]{40,64}$/i.test(String(repository.head ?? ''))
              || !/^[0-9a-f]{64}$/.test(String(repository.worktreeSha256 ?? ''))) {
            unsafe = `repository '${id}' is missing its exact checkout proof`;
            break;
          }
          const observedHead = gitValue(observedPath, ['rev-parse', 'HEAD'], {
            env: dropGitEnv
          });
          const observedFingerprint = worktreeFingerprint(observedPath, {
            fresh: true, env: dropGitEnv, exhaustive: true
          });
          if (observedHead !== repository.head
              || (repository.worktreeSha256
                && observedFingerprint.sha256 !== repository.worktreeSha256)) {
            unsafe = `repository '${id}' bytes no longer match the recorded checkout proof`;
            break;
          }
        }
        candidates.push({
          id, source, staged, quarantine, sourceInfo, stagedInfo, quarantineInfo,
          repository: {
            ...workspace.repositories[id],
            id,
            url: repository.url,
            defaultBranch: repository.defaultBranch
          },
          recorded: repository
        });
      }
      if (seen.size !== plannedDrops.size && !unsafe) {
        unsafe = 'recorded repositories do not exactly match the sealed drop plan';
      }
      if (!unsafe) {
        try {
          assertWorkspaceCapabilityDropPathsIsolated(workspace, candidates.flatMap((candidate) => [
            { id: candidate.id, path: candidate.source },
            ...(candidate.stagedInfo ? [{ id: candidate.id, path: candidate.staged }] : []),
            ...(candidate.quarantineInfo ? [{ id: candidate.id, path: candidate.quarantine }] : [])
          ]));
        } catch (error) {
          unsafe = error?.message || String(error);
        }
      }
      if (unsafe) {
        blockers.push(`${file}: ${unsafe}`);
        continue;
      }
      recoveries.push({ directory, recoveryMode, candidates, transaction });
    }
    if (blockers.length) {
      throw new SingularityFlowError(
        `Workspace capability-drop recovery is blocked. Retained for manual inspection: ${blockers.join(' | ')}`,
        {
          code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED',
          details: { blockers }
        }
      );
    }
    for (const recovery of recoveries) {
      for (const repository of recovery.candidates) {
        if (!repository.stagedInfo && !repository.quarantineInfo) continue;
        await assertInside(workspace.path, recovery.directory);
        await assertInside(workspace.path, repository.staged);
        await assertInside(workspace.path, repository.quarantine);
        await assertInside(workspace.path, repository.source);
        const retainedPath = repository.quarantineInfo
          ? repository.quarantine : repository.staged;
        if (recovery.recoveryMode === 'restore') {
          await rename(retainedPath, repository.source);
        } else if (repository.quarantineInfo) {
          const quarantinedRecord = { ...repository.recorded, staged: repository.quarantine };
          await verifyStagedDropRepository(
            workspace, repository.repository, quarantinedRecord, {
              refreshOrigin: true, env: dropGitEnv
            }
          );
          removeDropRepositoryFromQuarantine(
            workspace, repository.repository, repository.quarantine, repository.recorded
          );
        } else {
          await finalizeStagedDropRepository(
            workspace, repository.repository, repository.recorded, {
              refreshOrigin: true, env: dropGitEnv
            }
          );
        }
      }
      try {
        await assertInside(workspace.path, recovery.directory);
        if (!(await removeCompletedDropTransaction(recovery.directory, recovery.transaction))) {
          throw new Error('transaction directory changed during final cleanup');
        }
      } catch (error) {
        throw new SingularityFlowError(
          `Workspace capability-drop recovery completed its repository action but retained the transaction receipt: ${error.message}`,
          { code: 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED' }
        );
      }
    }
  });
}

function currentDropRecoveryPath(
  workspace, id, relativePath, source, staged, quarantine, transactionRoot
) {
  const resolvedWorkspace = path.resolve(workspace.path);
  const inside = (candidate, parent) => candidate.startsWith(`${path.resolve(parent)}${path.sep}`);
  const normalizedRelative = safeRelative(relativePath, `Workspace repository '${id}' recovery path`);
  const expectedSource = path.resolve(workspace.path, normalizedRelative);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    && normalizedRelative.startsWith('repos/')
    && source === expectedSource
    && inside(source, path.join(workspace.path, 'repos'))
    && staged === path.resolve(transactionRoot, id)
    && quarantine === `${path.resolve(transactionRoot, id)}.deleting`
    && inside(transactionRoot, resolvedWorkspace);
}

function gitValue(root, args, { env = process.env } = {}) {
  const result = run('git', args, { cwd: root, env, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function gitValueAsync(root, args, {
  env = process.env,
  timeoutMs = Number(process.env.SINGULARITY_FLOW_GIT_LOCAL_TIMEOUT_MS ?? 30_000),
  maxBytes = 1024 * 1024,
  signal = null,
  spawnCommand = spawn
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let terminated = false;
    let timer = null;
    let forceTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', terminate);
      resolve(value);
    };
    let child;
    const terminate = () => {
      if (!child || settled) return;
      terminated = true;
      child.kill('SIGTERM');
      forceTimer ??= setTimeout(() => {
        child?.kill('SIGKILL');
        finish(null);
      }, 1_000);
    };
    if (signal?.aborted) return finish(null);
    try {
      child = spawnCommand('git', args, {
        cwd: root, shell: false, windowsHide: true,
        env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      return finish(null);
    }
    let stdout = '';
    let bytes = 0;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) return terminate();
      stdout += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(
      !terminated && code === 0 && bytes <= maxBytes ? stdout.trim() : null
    ));
    signal?.addEventListener('abort', terminate, { once: true });
    const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
    timer = setTimeout(terminate, boundedTimeout);
  });
}

async function writeJournal(root, journal, logsDirectory = 'logs') {
  const file = path.join(root, logsDirectory, 'workspace-materialization.json');
  await assertInside(root, file);
  await atomicJson(file, journal);
}

function materializationOperation(root, repository) {
  return {
    action: repository.adoption ? 'adopt' : 'clone',
    repository: repository.id,
    url: repository.url,
    target: repository.adoption?.canonicalPath ?? path.join(root, repository.path),
    branch: repository.defaultBranch,
    required: repository.required,
    clone: repository.clone,
    adoption: repository.adoption
  };
}

async function verifyAdoptionOperation(operation) {
  const observed = await workspaceRepositoryDefaults(operation.target);
  const proof = observed.adoption;
  if (observed.url !== storableRemote(operation.url)) {
    return { status: 1, error: `Existing clone origin changed after review: ${operation.target}` };
  }
  if (proof.proofHash !== operation.adoption?.proofHash) {
    return { status: 1, error: `Existing clone state changed after review. Inspect it again before adoption: ${operation.target}` };
  }
  if (proof.dirty && operation.adoption?.dirtyAcceptedHash !== proof.worktreeStatusHash) {
    return {
      status: 1,
      error: `Existing clone has uncommitted work. Review it and confirm dirty-state hash ${proof.worktreeStatusHash}; nothing was fetched, switched, stashed, committed, reset, or cleaned.`
    };
  }
  return {
    status: 0, error: null,
    clone: { mode: 'adopted-existing-clone', fallback: 'refuse', sparseCone: [] },
    fallbackUsed: false,
    adoption: proof,
    cleanup: null
  };
}

/**
 * Turn Git's multi-line clone transcript into one safe, actionable sentence.
 *
 * VS Code notifications show the first line prominently. Git writes the useless progress line
 * "Cloning into …" first and the diagnosis last, so passing stderr through verbatim made a missing
 * branch look like an unexplained clone. Remote credentials are also removed before a URL is shown.
 */
function cloneFailure(operation, result) {
  const remote = sanitizeRemote(operation.url);
  const classified = result?.failure
    ?? classifyGitRemoteFailure(result, { branch: operation.branch });
  if (classified.classification === 'branch-not-found') {
    return `Repository '${operation.repository}' cannot clone branch '${operation.branch}' from '${remote}': `
      + `the remote does not have that branch. Configure a valid default branch or create '${operation.branch}', then repair again.`;
  }
  if (classified.classification === 'authentication-required') {
    return `Repository '${operation.repository}' cannot authenticate to '${remote}'. Sign in to Git or configure its credential helper, then repair again.`;
  }
  if (classified.classification === 'authorization-denied') {
    return `Repository '${operation.repository}' is not readable with the current Git identity at '${remote}'. Request access, then repair again.`;
  }
  if (classified.classification === 'remote-not-found') {
    return `Repository '${operation.repository}' cannot reach '${remote}'. Correct its clone URL or restore the remote, then repair again.`;
  }
  if (classified.classification !== 'unknown') {
    return `Repository '${operation.repository}' cannot clone branch '${operation.branch}' from '${remote}' `
      + `because Git classified the failure as ${classified.classification}. ${classified.advice}`;
  }
  return `Repository '${operation.repository}' could not clone branch '${operation.branch}' from '${remote}': `
    + `Git returned an unrecognized failure (exit ${result.status}). Run workspace doctor --network, correct Git access, then repair again.`;
}

async function cloneIntoWorkspace(root, operation, {
  deferClaim = false, env = process.env
} = {}) {
  await assertInside(root, operation.target);
  const existing = await lstat(operation.target).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      return { status: 1, error: `Clone target became occupied before materialization: ${operation.target}` };
    }
    const entries = await readdir(operation.target);
    if (entries.length) return { status: 1, error: `Clone target became occupied before materialization: ${operation.target}` };
  }
  const parent = path.dirname(operation.target);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  const stagingRoot = await mkdtemp(path.join(parent, '.sflow-clone-'));
  const staging = path.join(stagingRoot, 'repository');
  const ownershipFile = path.join(stagingRoot, '.sflow-bootstrap-owner.json');
  const canonicalStagingRoot = await realpath(stagingRoot).catch(() => null);
  let ownership;
  try {
    if (!canonicalStagingRoot || path.dirname(canonicalStagingRoot) !== canonicalParent) {
      throw new Error('new staging directory escaped its workspace repository parent');
    }
    await assertInside(root, staging);
    ownership = {
      schemaVersion: currentSchemaVersion('workspace-bootstrap-owner'),
      bootstrapId: String(operation.bootstrapId ?? `workspace-${operation.workspaceId ?? 'unbound'}`),
      repositoryId: operation.repository,
      canonicalPath: canonicalStagingRoot,
      targetPath: path.resolve(operation.target),
      createdAt: nowIso(),
      nonce: randomUUID()
    };
    await writeFile(ownershipFile, `${JSON.stringify(ownership, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const info = await lstat(stagingRoot).catch(() => null);
    const canonical = !info?.isSymbolicLink() && info?.isDirectory()
      ? await realpath(stagingRoot).catch(() => null) : null;
    const removable = canonical === canonicalStagingRoot && path.dirname(canonical ?? '') === canonicalParent;
    if (removable) await rm(stagingRoot, { recursive: true, force: true });
    return {
      status: 1,
      error: `Repository '${operation.repository}' could not initialize its private clone staging area: ${error.message}.`
        + (removable ? '' : ` Inspect retained staging path ${stagingRoot}.`)
    };
  }

  const verifyOwnership = async () => {
    const info = await lstat(stagingRoot).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
    const canonical = await realpath(stagingRoot).catch(() => null);
    if (canonical !== ownership.canonicalPath || path.dirname(canonical) !== canonicalParent) return false;
    let recorded;
    try { recorded = readRecord('workspace-bootstrap-owner', await readFile(ownershipFile)).record; }
    catch { return false; }
    return recorded.bootstrapId === ownership.bootstrapId
      && recorded.repositoryId === ownership.repositoryId
      && recorded.nonce === ownership.nonce
      && recorded.canonicalPath === ownership.canonicalPath
      && recorded.targetPath === ownership.targetPath;
  };

  const cleanupStaging = async () => {
    if (!(await verifyOwnership())) return false;
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    if (entries.some((entry) => !['.sflow-bootstrap-owner.json', 'repository'].includes(entry.name))) return false;
    const repositoryEntry = entries.find((entry) => entry.name === 'repository');
    if (repositoryEntry?.isSymbolicLink()) return false;
    if (repositoryEntry) await rm(staging, { recursive: true, force: true });
    await rm(ownershipFile, { force: true });
    await rmdir(stagingRoot);
    return true;
  };

  const cleanupFailure = async (message) => {
    if (await cleanupStaging()) return message;
    return `${message} The staging directory was retained for inspection because its ownership could not be proven: ${stagingRoot}`;
  };
  try {
  const strategy = normalizeCloneStrategy(operation.clone, `Repository '${operation.repository}' clone strategy`);
  const gitEnv = enterpriseGitEnvironment(env);
  const transport = frozenRemoteTransport(operation.url, { env: gitEnv });
  // Check out the configured default branch, but retain remote-tracking refs for governed Epic
  // and Story branches. State transfer depends on seeing branches created from other terminals.
  const cloneOnce = (selected) => runRemoteGitAsync([
    'clone', '--branch', operation.branch, ...cloneStrategyArguments(selected),
    '--', transport.remote, staging
  ], { cwd: root, operation: 'remote-configuration', env: transport.env });
  const restoreExactOrigin = () => {
    run('git', ['remote', 'set-url', 'origin', operation.url], {
      cwd: staging, env: transport.env
    });
    const configured = run('git', ['config', '--local', '--get', 'remote.origin.url'], {
      cwd: staging, env: transport.env
    }).stdout.trim();
    if (configured !== operation.url) {
      throw new SingularityFlowError(
        `Repository '${operation.repository}' clone did not retain its exact reviewed origin URL.`
      );
    }
  };
  incrementCommandCounter('git.remote-clone');
  let selected = strategy;
  let fallbackUsed = false;
  let result = await cloneOnce(selected);
  let partial = selected.mode === 'full' ? null : partialCloneFallbackDecision(result, {
    configured: result.status === 0
      ? partialCloneConfigured(staging, 'origin', (args, options) => run('git', args, {
          ...options, env: transport.env
        }))
      : null,
    fallback: selected.fallback
  });
  const resetForFullClone = async () => {
    if (!(await verifyOwnership())) {
      return `Repository '${operation.repository}' needs a full-clone fallback, but the staging ownership marker no longer verifies. Inspect ${stagingRoot}; nothing was published.`;
    }
    const stagedInfo = await lstat(staging).catch(() => null);
    if (stagedInfo?.isSymbolicLink()) {
      return `Repository '${operation.repository}' staging path became a symbolic link. Inspect ${stagingRoot}; nothing was published.`;
    }
    await rm(staging, { recursive: true, force: true });
    return null;
  };
  const cloneFullOnce = async () => {
    const resetError = await resetForFullClone();
    if (resetError) return { status: 1, error: resetError };
    selected = normalizeCloneStrategy({ mode: 'full', fallback: 'full' });
    fallbackUsed = true;
    result = await cloneOnce(selected);
    if (result.status !== 0) {
      return { status: result.status, error: await cleanupFailure(cloneFailure(operation, result)) };
    }
    return null;
  };

  if (result.status !== 0) {
    // A full retry can fix only an explicit server capability refusal. Repeating an authentication,
    // proxy, TLS, timeout, or generic network failure doubles the office delay and obscures the real
    // diagnosis.
    if (selected.mode === 'full' || partial?.action !== 'retry-full') {
      return { status: result.status, error: await cleanupFailure(cloneFailure(operation, result)) };
    }
    const fallbackFailure = await cloneFullOnce();
    if (fallbackFailure) return fallbackFailure;
    partial = null;
  }

  if (selected.mode !== 'full'
      && ['retain-full', 'refuse-full', 'refuse-unverified'].includes(partial?.action)) {
    if (partial.action !== 'retain-full') {
      return {
        status: 1,
        error: await cleanupFailure(`Repository '${operation.repository}' did not establish a blobless partial clone with verified promisor configuration. `
          + (partial.action === 'refuse-full'
            ? `The server ignored or rejected filter=blob:none; clone fallback is 'refuse', so a full monorepo was not retained.`
            : 'Git did not expose a verifiable promisor/filter configuration, so the checkout was not retained.'))
      };
    }
    // Git may accept `--filter` but explicitly retain a complete checkout. Prove its object graph
    // without lazy fetching and normalize a sparse working tree locally. This avoids downloading the
    // same monorepo a second time merely to give the already-complete clone a different label.
    const complete = run('git', ['fsck', '--connectivity-only', '--no-dangling'], {
      cwd: staging, allowFailure: true,
      env: { ...transport.env, GIT_NO_LAZY_FETCH: '1' }
    });
    if (complete.status === 0) {
      if (selected.mode === 'blobless-sparse') {
        const expanded = run('git', ['sparse-checkout', 'disable'], {
          cwd: staging, allowFailure: true, env: transport.env
        });
        if (expanded.status !== 0) {
          return {
            status: expanded.status,
            error: await cleanupFailure(`Repository '${operation.repository}' downloaded a complete clone but Git could not disable its sparse checkout. `
              + safeGitDiagnosticReference(expanded, 'Git refused to expand the working tree'))
          };
        }
      }
      selected = normalizeCloneStrategy({ mode: 'full', fallback: 'full' });
      fallbackUsed = true;
    } else {
      const fallbackFailure = await cloneFullOnce();
      if (fallbackFailure) return fallbackFailure;
    }
  }
  if (strategy.mode === 'blobless-sparse' && !fallbackUsed) {
    const sparse = run('git', ['sparse-checkout', 'set', '--cone', '--', ...strategy.sparseCone], {
      cwd: staging,
      env: transport.env,
      allowFailure: true
    });
    if (sparse.status !== 0) {
      return {
        status: sparse.status,
        error: await cleanupFailure(`Repository '${operation.repository}' cloned partially but sparse checkout could not select `
          + `${strategy.sparseCone.join(', ')}. ${safeGitDiagnosticReference(sparse, 'Git refused the cone paths')}`)
      };
    }
  }
  // All checkout and possible lazy-fetch work is complete. Only now replace the invocation alias
  // with the exact reviewed URL so the durable workspace never depends on ephemeral Git config.
  restoreExactOrigin();
  const claim = async () => {
    try {
      // A user may pre-create the repository folder while setting up a workspace. Claim it only
      // when it is still empty after the clone completes; rmdir fails if a concurrent process
      // added anything, so no user content is overwritten.
      if (existing) await rmdir(operation.target);
      await rename(staging, operation.target);
      const cleaned = await cleanupStaging();
      return {
        status: 0, error: null, clone: selected, fallbackUsed,
        cleanup: cleaned
          ? { status: 'removed', path: stagingRoot, recoverable: false }
          : { status: 'retained', path: stagingRoot, recoverable: true }
      };
    } catch (error) {
      return {
        status: 1,
        error: await cleanupFailure(`Clone completed but could not claim its workspace target: ${error.message}`)
      };
    }
  };
  if (deferClaim) {
    return {
      status: 0, error: null, clone: selected, fallbackUsed,
      staging: { path: stagingRoot },
      claim,
      discard: async () => ({
        removed: await cleanupStaging(), path: stagingRoot
      })
    };
  }
  return claim();
  } catch (error) {
    let message = `Repository '${operation.repository}' clone staging failed: ${error instanceof Error ? error.message : String(error)}.`;
    try { message = await cleanupFailure(message); }
    catch { message += ` Inspect retained staging path ${stagingRoot}.`; }
    return { status: 1, error: message };
  }
}

async function discardStagedWorkspaceClone(result) {
  if (result?.status !== 0 || typeof result.discard !== 'function') return null;
  try {
    const cleanup = await result.discard();
    return {
      removed: cleanup?.removed === true,
      path: cleanup?.path ?? result.staging?.path ?? null,
      error: null
    };
  } catch (error) {
    return {
      removed: false,
      path: result.staging?.path ?? null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readRepairJournal(workspace, repositories) {
  const file = path.join(workspace.path, workspace.directories.logs, 'workspace-materialization.json');
  await assertInside(workspace.path, file);
  let previous = null;
  try { previous = JSON.parse(await readFile(file, 'utf8')); } catch {}
  const previousOperations = new Map(
    Array.isArray(previous?.operations)
      ? previous.operations.filter((operation) => operation?.repository).map((operation) => [operation.repository, operation])
      : []
  );
  return {
    version: 1,
    bootstrapId: previous?.bootstrapId ?? null,
    workspaceId: workspace.id,
    anchorKey: workspace.anchor.key,
    startedAt: previous?.workspaceId === workspace.id && Number.isFinite(Date.parse(previous.startedAt))
      ? new Date(previous.startedAt).toISOString()
      : nowIso(),
    completedAt: null,
    recoveredAt: previous?.workspaceId === workspace.id ? previous.recoveredAt ?? null : nowIso(),
    operations: repositories.map((repository) => ({
      ...materializationOperation(workspace.path, repository),
      ...(previousOperations.get(repository.id) ?? {}),
      ...materializationOperation(workspace.path, repository),
      status: repository.state === 'ready' ? 'complete' : 'pending',
      error: repository.state === 'ready' ? null : previousOperations.get(repository.id)?.error ?? null,
      completedAt: repository.state === 'ready'
        ? previousOperations.get(repository.id)?.completedAt ?? nowIso()
        : previousOperations.get(repository.id)?.completedAt ?? null
    }))
  };
}

export async function createWorkspace(options, {
  confirmation,
  clone = true,
  bootstrapId = null,
  workers = null,
  capabilityValidation = null,
  env = process.env,
  cloneOperation = cloneIntoWorkspace,
  adoptionOperation = verifyAdoptionOperation
} = {}) {
  const preview = previewWorkspace(options);
  const { root, manifest } = preview;
  // Snapshot one office-safe Git environment for validation and every clone in this creation. Each
  // later CLI command takes a fresh snapshot, while repositories in this bounded wave share proxy,
  // CA, credential-helper and executable-isolation semantics without repeated config subprocesses.
  // A document-only workspace with no capability authority and no materialization pays no Git
  // configuration subprocess at all.
  const requiresRemoteGit = clone || (manifest.capabilities?.length ?? 0) > 0
    || Object.values(manifest.repositories ?? {})
      .some((repository) => (repository.capabilities?.length ?? 0) > 0);
  const gitEnv = requiresRemoteGit ? enterpriseGitEnvironment(env) : env;
  const confirmationLabel = manifest.anchor.provider === 'jira' ? 'Jira-key' : 'workspace-ID';
  if (confirmation !== manifest.anchor.key) throw new SingularityFlowError(`Workspace creation requires exact ${confirmationLabel} confirmation '${manifest.anchor.key}'.`);
  // Authority is checked after the exact human confirmation but before even the workspace parent
  // directory is created. An invalid capability selection therefore leaves no shell, manifest, or
  // repair journal behind for a later command to mistake for a resumable workspace.
  await validateWorkspaceCapabilityRegistration(manifest, {
    receipt: capabilityValidation, env: gitEnv,
    remoteSession: new GitRemoteSession({ env: gitEnv })
  });
  const existing = await stat(root).catch(() => null);
  if (existing && !(await stat(path.join(root, WORKSPACE_FILE)).catch(() => null))) {
    throw new SingularityFlowError(`Workspace target already exists and is not managed by Singularity Flow: ${root}`);
  }
  if (existing) {
    const current = await readWorkspace(root);
    if (current.id !== manifest.id) throw new SingularityFlowError(`Workspace target contains unrelated workspace '${current.id}'.`);
    if (!sameWorkspaceMaterializationPlan(current, manifest)) {
      throw new SingularityFlowError(
        `Workspace target contains the same workspace identity but a different repository materialization plan. `
        + `Open the existing workspace as configured, or choose a different workspace location.`
      );
    }
    if (clone) {
      const repaired = await repairWorkspace(current.path, {
        workers, cloneOperation, adoptionOperation, env: gitEnv
      });
      return {
        created: false,
        resumed: true,
        workspace: repaired.status.workspace,
        status: repaired.status,
        repair: repaired.repaired
      };
    }
    return { created: false, resumed: true, workspace: current, status: await workspaceStatus(current.path), repair: [] };
  }
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(root, { recursive: false });
  for (const directory of workspaceDirectories(manifest)) await mkdir(path.join(root, directory), { recursive: true });
  const journal = {
    version: 1,
    bootstrapId,
    workspaceId: manifest.id,
    anchorKey: manifest.anchor.key,
    startedAt: nowIso(),
    completedAt: null,
    operations: preview.operations.map((operation) => ({ ...operation, status: clone ? 'pending' : 'planned', error: null }))
  };
  await atomicJson(path.join(root, WORKSPACE_FILE), manifest);
  if (options.hierarchySnapshot) {
    await atomicJson(path.join(root, manifest.directories.jiraCache, 'hierarchy.json'), {
      ...options.hierarchySnapshot,
      workspaceId: manifest.id,
      anchorKey: manifest.anchor.key,
      cachedAt: nowIso(),
      source: 'jira-observation'
    });
  }
  await writeJournal(root, journal, manifest.directories.logs);
  if (clone) {
    for (const operation of journal.operations) {
      operation.status = 'running';
      operation.startedAt = nowIso();
    }
    await writeJournal(root, journal, manifest.directories.logs);
    const stagedResults = await mapLimit(
      journal.operations,
      gitWorkerCount(journal.operations.length, { requested: workers }),
      async (operation) => {
        try {
              return operation.action === 'adopt'
                ? await adoptionOperation(operation)
                : await cloneOperation(root, {
                    ...operation,
                    bootstrapId,
                    workspaceId: manifest.id
                  }, { deferClaim: true, env: gitEnv });
        } catch (error) {
          return { status: 1, error: error instanceof Error ? error.message : String(error) };
        }
      }
    );
    const claimedStagedResults = new Set();
    try {
    const requiredFailure = journal.operations.find((operation, index) =>
      operation.required && stagedResults[index].status !== 0);
    if (requiredFailure) {
      const cleanup = await Promise.all(stagedResults.map(discardStagedWorkspaceClone));
      journal.operations.forEach((operation, index) => {
        const result = stagedResults[index];
        const discarded = cleanup[index];
        operation.status = result.status !== 0 ? 'failed'
          : operation.action === 'adopt' ? 'complete'
            : discarded?.removed ? 'pending' : 'failed';
        operation.error = result.status !== 0 ? result.error
          : operation.action === 'adopt' ? null
            : discarded?.removed
              ? `Staged clone was discarded because required repository '${requiredFailure.repository}' failed.`
              : `Staged clone could not be safely discarded after required repository '${requiredFailure.repository}' failed.`
                + `${discarded?.path ? ` Inspect ${discarded.path}.` : ''}`
                + `${discarded?.error ? ` ${discarded.error}` : ''}`;
        operation.adoptionProof = operation.action === 'adopt' ? result.adoption ?? null : null;
        operation.cleanup = discarded;
        operation.completedAt = nowIso();
      });
      await writeJournal(root, journal, manifest.directories.logs);
      const failedResult = stagedResults[journal.operations.indexOf(requiredFailure)];
      throw new SingularityFlowError(
        `Workspace retained for repair after ${requiredFailure.repository} clone failed: ${failedResult.error}`);
    }
    for (let index = 0; index < journal.operations.length; index += 1) {
      const operation = journal.operations[index];
      const staged = stagedResults[index];
      const result = staged.status === 0 && staged.claim ? await staged.claim() : staged;
      if (staged.status === 0 && staged.claim && result.status === 0) {
        claimedStagedResults.add(staged);
      }
      operation.status = result.status === 0 ? 'complete' : 'failed';
      operation.error = result.error;
      operation.actualClone = result.status === 0 ? result.clone : null;
      operation.fallbackUsed = result.status === 0 ? result.fallbackUsed : false;
      operation.cleanup = result.cleanup ?? null;
      operation.adoptionProof = result.adoption ?? null;
      operation.completedAt = nowIso();
      await writeJournal(root, journal, manifest.directories.logs);
      if (result.status !== 0 && operation.required) {
        const laterCleanup = await Promise.all(
          stagedResults.slice(index + 1).map(discardStagedWorkspaceClone)
        );
        for (let later = index + 1; later < journal.operations.length; later += 1) {
          const laterOperation = journal.operations[later];
          const laterResult = stagedResults[later];
          const discarded = laterCleanup[later - index - 1];
          laterOperation.status = laterResult.status !== 0 ? 'failed'
            : laterOperation.action === 'adopt' ? 'complete'
              : discarded?.removed ? 'pending' : 'failed';
          laterOperation.error = laterResult.status !== 0 ? laterResult.error
            : laterOperation.action === 'adopt' ? null
              : discarded?.removed
                ? `Staged clone was discarded because required repository '${operation.repository}' failed during final claim.`
                : `Staged clone could not be safely discarded after required repository '${operation.repository}' failed during final claim.`
                  + `${discarded?.path ? ` Inspect ${discarded.path}.` : ''}`
                  + `${discarded?.error ? ` ${discarded.error}` : ''}`;
          laterOperation.adoptionProof = laterOperation.action === 'adopt'
            ? laterResult.adoption ?? null : null;
          laterOperation.cleanup = discarded;
          laterOperation.completedAt = nowIso();
        }
        await writeJournal(root, journal, manifest.directories.logs);
        throw new SingularityFlowError(`Workspace retained for repair after ${operation.repository} clone failed: ${operation.error}`);
      }
    }
    journal.completedAt = nowIso();
    await writeJournal(root, journal, manifest.directories.logs);
    } finally {
      // A claim callback or journal write may throw outside the normal result protocol. Always
      // release every still-private clone from the staging wave; successfully claimed targets are
      // intentionally retained as durable repair progress.
      await Promise.all(stagedResults
        .filter((staged) => !claimedStagedResults.has(staged))
        .map(discardStagedWorkspaceClone));
    }
  }
  const finalStatus = await workspaceStatus(root);
  return {
    created: true,
    resumed: false,
    workspace: finalStatus.workspace,
    status: finalStatus,
    materialization: journal.operations.map((operation) => ({
      repository: operation.repository,
      requested: operation.clone,
      actual: operation.actualClone ?? null,
      fallbackUsed: operation.fallbackUsed === true,
      status: operation.status,
      error: operation.error ?? null
    }))
  };
}

async function repositoryWorldModelStatus(root) {
  const defaultOutputDirectory = 'singularity/world-model';
  const canonicalRoot = await realpath(root);
  async function regularRepositoryFile(relative) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) return { state: 'outside', absolute };
    const info = await lstat(absolute).catch(() => null);
    if (!info) return { state: 'missing', absolute };
    if (!info.isFile() || info.isSymbolicLink()) return { state: 'invalid', absolute };
    const canonical = await realpath(absolute);
    if (!canonical.startsWith(`${canonicalRoot}${path.sep}`)) return { state: 'outside', absolute };
    return { state: 'file', absolute };
  }

  let outputDirectory = defaultOutputDirectory;
  const workflow = await regularRepositoryFile('singularity/workflow.yml');
  if (workflow.state === 'file') {
    try {
      const definition = YAML.parse(await readFile(workflow.absolute, 'utf8'));
      outputDirectory = String(definition?.worldModel?.outputDir ?? defaultOutputDirectory).trim() || defaultOutputDirectory;
    } catch {
      // Workspace creation must not turn workflow parsing into a world-model gate. The normal
      // repository validator will report malformed configuration after the clone is opened.
      outputDirectory = defaultOutputDirectory;
    }
  }

  const normalizedOutput = outputDirectory.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!normalizedOutput || path.isAbsolute(normalizedOutput) || normalizedOutput.split('/').includes('..')) {
    return {
      state: 'invalid',
      exists: false,
      outputDirectory: normalizedOutput || outputDirectory,
      manifestPath: null,
      warning: `The configured world-model directory '${outputDirectory}' is not repository-relative.`
    };
  }
  const manifestPath = `${normalizedOutput}/manifest.json`;
  const manifest = await regularRepositoryFile(manifestPath);
  if (manifest.state === 'outside') {
    return {
      state: 'invalid',
      exists: false,
      outputDirectory: normalizedOutput,
      manifestPath,
      warning: `The configured world-model manifest escapes the repository: ${manifestPath}.`
    };
  }
  if (manifest.state === 'missing') {
    // Repository models are normally governed on the state branch and may intentionally be absent
    // from the application checkout. Resolve that authority before describing the repository as
    // ungrounded; workspace status is read-only, so it uses already-fetched refs and never triggers
    // a network request or a rebuild.
    try {
      const [{ loadDefinition }, grounding, authorityConfig] = await Promise.all([
        import('./config.mjs'),
        import('./grounding.mjs'),
        import('./world-model/authority-config.mjs')
      ]);
      const definition = await loadDefinition(root);
      const state = authorityConfig.worldModelStateAuthority(definition);
      const source = await grounding.worldModelSourceSnapshot(root, definition);
      const located = await grounding.resolveWorldModelSource(root, {
        ...(definition.worldModel ?? {}),
        outputDir: normalizedOutput,
        stateBranch: state.branch,
        remote: state.remote,
        ledger: definition.ledger,
        definition
      }, { refreshRemote: false, sourceTreeSha256: source.sha256 });
      const validated = await grounding.validateWorldModelDirectory(located.directory, {
        integrity: 'full',
        sourceLabel: located.source === 'state-branch'
          ? `governed state-branch world model '${located.branch}'`
          : 'application-projection world model'
      });
      const freshness = await grounding.worldModelFreshness(root, definition, validated.manifest);
      if (!freshness.fresh || freshness.built !== source.sha256) {
        throw new SingularityFlowError(`Preserved model describes ${freshness.built ?? 'an unknown source'}, not ${source.sha256}.`);
      }
      return {
        state: 'available',
        exists: true,
        source: located.source,
        authority: located.authority ?? null,
        historical: located.historical === true,
        outputDirectory: normalizedOutput,
        manifestPath: `${normalizedOutput}/manifest.json`,
        snapshotRef: located.snapshotRef ?? located.commit ?? null,
        generatedAt: validated.manifest.generated_at ?? validated.manifest.generatedAt ?? null,
        warning: null
      };
    } catch (error) {
      return {
        // Preserve the public compatibility value consumed by workspace automation. The more
        // precise projection diagnosis is additive rather than a silent state-enum replacement.
        state: 'missing',
        projectionStatus: 'not-projected',
        exists: false,
        source: 'application-projection',
        outputDirectory: normalizedOutput,
        manifestPath,
        generatedAt: null,
        warning: `No world model is projected into the checked-out application branch at ${manifestPath}; governed state was not available for this read (${error.message}).`
      };
    }
  }
  if (manifest.state !== 'file') {
    return {
      state: 'invalid',
      exists: false,
      outputDirectory: normalizedOutput,
      manifestPath,
      generatedAt: null,
      warning: `The repository world-model manifest is not a regular file: ${manifestPath}.`
    };
  }
  try {
    const definition = JSON.parse(await readFile(manifest.absolute, 'utf8'));
    return {
      state: 'available',
      exists: true,
      outputDirectory: normalizedOutput,
      manifestPath,
      generatedAt: definition.generated_at ?? definition.generatedAt ?? null,
      warning: null
    };
  } catch {
    return {
      state: 'invalid',
      exists: true,
      outputDirectory: normalizedOutput,
      manifestPath,
      generatedAt: null,
      warning: `The repository world-model manifest is not valid JSON: ${manifestPath}.`
    };
  }
}

async function repositoryStatus(root, repository, {
  level = 'full',
  env = process.env
} = {}) {
  const absolute = repository.adoption?.canonicalPath ?? path.join(root, repository.path);
  if (repository.adoption) {
    const canonical = await realpath(absolute).catch(() => null);
    const info = await lstat(absolute).catch(() => null);
    if (!canonical || canonical !== repository.adoption.canonicalPath || info?.isSymbolicLink()) {
      return { ...repository, absolutePath: absolute, state: 'adoption-path-invalid', dirty: null, branch: null, remote: null, head: null };
    }
  } else {
    try {
      await assertInside(root, absolute);
    } catch (error) {
      return {
        ...repository,
        absolutePath: absolute,
        state: 'invalid-path',
        error: error.message,
        dirty: null,
        branch: null,
        remote: null,
        head: null
      };
    }
  }
  const directory = await lstat(absolute).catch(() => null);
  if (!directory) return { ...repository, absolutePath: absolute, state: 'missing', dirty: null, branch: null, remote: null };
  if (directory?.isSymbolicLink()) return { ...repository, absolutePath: absolute, state: 'invalid-symlink', dirty: null, branch: null, remote: null };
  if (!directory.isDirectory()) return { ...repository, absolutePath: absolute, state: 'invalid', dirty: null, branch: null, remote: null };
  const git = await stat(path.join(absolute, '.git')).catch(() => null);
  if (!git) {
    const entries = await readdir(absolute);
    return {
      ...repository,
      absolutePath: absolute,
      state: entries.length ? 'invalid' : 'empty',
      dirty: null,
      branch: null,
      remote: null,
      worldModel: null
    };
  }
  // These are independent local reads. Running them concurrently keeps a workspace with many
  // repositories from serially blocking the extension host on four spawnSync calls per repository.
  const readinessOnly = level === 'readiness';
  const [statusText, branch, remote, headCommit] = await Promise.all([
    readinessOnly
      ? Promise.resolve('')
      : gitValueAsync(absolute, ['status', '--porcelain=v1', level === 'summary'
        ? '--untracked-files=no' : '--untracked-files=all'], { env }),
    gitValueAsync(absolute, ['branch', '--show-current'], { env }),
    // Read the durable identity rather than Git's operationally rewritten URL. Workspace transports
    // freeze this exact value per invocation; ambient url.* rules are neither manifest authority nor
    // permission to make an otherwise correct clone look permanently misconfigured.
    gitValueAsync(absolute, ['config', '--local', '--get', 'remote.origin.url'], { env }),
    gitValueAsync(absolute, ['rev-parse', 'HEAD'], { env })
  ]);
  const dirty = Boolean(statusText);
  let operationalRemote = null;
  try { operationalRemote = storableRemote(remote, { redactCredentials: true }); }
  catch { /* an unsafe configured remote is a mismatch, not a status-read crash */ }
  return {
    ...repository,
    absolutePath: absolute,
    // Diagnostics may redact transport syntax, but equality must preserve the exact credential-free
    // configured URL. Local and SCP-like paths can contain literal `?`/`#` characters.
    state: operationalRemote === repository.url
      ? 'ready' : 'remote-mismatch',
    dirty,
    branch,
    remote: sanitizeRemote(remote),
    head: headCommit,
    worldModel: level === 'full' ? await repositoryWorldModelStatus(absolute) : null
  };
}

export async function workspaceStatus(workspacePath, {
  level = 'full',
  env = process.env
} = {}) {
  if (!['readiness', 'summary', 'full'].includes(level)) {
    throw new SingularityFlowError(`Unknown workspace status level '${level}'.`);
  }
  const workspace = await readWorkspace(workspacePath);
  const repositories = await Promise.all(Object.values(workspace.repositories).map((repository) =>
    repositoryStatus(workspace.path, repository, { level, env })));
  const staged = level === 'full' ? await listWorkspaceDocuments(workspace.path) : [];
  const warnings = repositories
    .filter((repository) => repository.state === 'ready' && repository.worldModel?.warning)
    .map((repository) => ({
      code: repository.worldModel.state === 'missing' ? 'world-model-missing' : 'world-model-invalid',
      repository: repository.id,
      message: `${repository.metadata?.name ?? repository.id}: ${repository.worldModel.warning}`
    }));
  return {
    workspace,
    level,
    healthy: repositories.every((repository) => repository.state === 'ready'),
    leadRepositoryPath: workspaceRepositoryPath(workspace, workspace.repositories[workspace.leadRepository]),
    repositories,
    stagedDocuments: staged,
    warnings,
    counts: {
      repositories: repositories.length,
      ready: repositories.filter((repository) => repository.state === 'ready').length,
      dirty: repositories.filter((repository) => repository.dirty).length,
      stagedDocuments: staged.length,
      worldModels: repositories.filter((repository) => repository.worldModel?.state === 'available').length
    }
  };
}

async function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) throw new SingularityFlowError('Workspace path escaped its configured root.');
  const canonicalRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
  const targetInfo = await lstat(resolvedTarget).catch(() => null);
  const canonicalTarget = targetInfo
    ? await realpath(resolvedTarget)
    : await realpath(path.dirname(resolvedTarget)).catch(() => path.dirname(resolvedTarget));
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new SingularityFlowError('Workspace path resolves outside its configured root.');
  }
  return resolvedTarget;
}

async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function stageWorkspaceDocuments(workspacePath, sourcePaths) {
  const workspace = await readWorkspace(workspacePath);
  const targetRoot = path.join(workspace.path, workspace.directories.stagedDocuments);
  await assertInside(workspace.path, targetRoot);
  await mkdir(targetRoot, { recursive: true });
  const sources = Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths];
  const added = [];
  for (const sourcePath of sources) {
    const source = path.resolve(sourcePath);
    const sourceInfo = await lstat(source).catch(() => null);
    if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) throw new SingularityFlowError(`Workspace document must be a regular file: ${source}`);
    const base = portableName(path.basename(source));
    const extension = path.extname(source);
    const stem = extension && base.toLowerCase().endsWith(extension.toLowerCase()) ? base.slice(0, -extension.length) : base;
    let destination = path.join(targetRoot, `${stem}${extension}`);
    let counter = 2;
    while (await stat(destination).catch(() => null)) destination = path.join(targetRoot, `${stem}-${counter++}${extension}`);
    await assertInside(workspace.path, destination);
    await copyFile(source, destination);
    const info = await stat(destination);
    added.push({
      name: path.basename(destination),
      path: path.relative(workspace.path, destination).replaceAll(path.sep, '/'),
      bytes: info.size,
      sha256: await hashFile(destination),
      status: 'staged-not-governed'
    });
  }
  return { workspaceId: workspace.id, added, warning: 'Staged documents are local and not governed until explicitly imported into a Git work item or initiative.' };
}

export async function listWorkspaceDocuments(workspacePath) {
  const workspace = await readWorkspace(workspacePath);
  const directory = path.join(workspace.path, workspace.directories.stagedDocuments);
  await assertInside(workspace.path, directory);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    const info = await stat(file);
    records.push({
      name: entry.name,
      path: path.relative(workspace.path, file).replaceAll(path.sep, '/'),
      bytes: info.size,
      sha256: await hashFile(file),
      status: 'staged-not-governed'
    });
  }
  return records;
}

export async function resolveWorkspaceDocument(workspacePath, documentPath) {
  const workspace = await readWorkspace(workspacePath);
  const relative = safeUnder(documentPath, 'documents', 'Workspace document path');
  const records = await listWorkspaceDocuments(workspace.path);
  const record = records.find((item) => item.path === relative);
  if (!record) throw new SingularityFlowError(`Workspace document '${relative}' is not in the staged-document inbox.`);
  const absolutePath = await assertInside(workspace.path, path.join(workspace.path, relative));
  const info = await lstat(absolutePath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new SingularityFlowError(`Workspace document '${relative}' is not a regular staged file.`);
  const sha256 = await hashFile(absolutePath);
  if (sha256 !== record.sha256) throw new SingularityFlowError(`Workspace document '${relative}' changed while it was being selected.`);
  return { ...record, absolutePath };
}

function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry.path !== 'string') return null;
  const workspacePath = path.resolve(entry.path);
  return {
    id: String(entry.id ?? path.basename(workspacePath)),
    path: workspacePath,
    name: String(entry.name ?? path.basename(workspacePath)),
    anchorKey: entry.anchorKey == null ? null : String(entry.anchorKey),
    anchorType: entry.anchorType == null ? null : String(entry.anchorType),
    siteId: entry.siteId == null ? null : String(entry.siteId),
    leadRepositoryPath: entry.leadRepositoryPath == null ? null : path.resolve(entry.leadRepositoryPath),
    openedAt: Number.isFinite(Date.parse(entry.openedAt)) ? new Date(entry.openedAt).toISOString() : new Date(0).toISOString(),
    archivedAt: Number.isFinite(Date.parse(entry.archivedAt)) ? new Date(entry.archivedAt).toISOString() : null
  };
}

export async function readWorkspaceRegistry(file) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { return []; }
  if (!Array.isArray(parsed)) parsed = readRecord('workspace-registry', parsed).record;
  const values = Array.isArray(parsed) ? parsed : parsed?.workspaces;
  if (!Array.isArray(values)) return [];
  const unique = new Map();
  for (const value of values) {
    const entry = normalizeRegistryEntry(value);
    if (!entry) continue;
    const originalPath = entry.path;
    entry.path = await realpath(originalPath).catch(() => originalPath);
    if (entry.leadRepositoryPath && entry.path !== originalPath) {
      const relativeLead = path.relative(originalPath, entry.leadRepositoryPath);
      if (relativeLead !== '..' && !relativeLead.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeLead)) {
        entry.leadRepositoryPath = path.join(entry.path, relativeLead);
      }
    }
    const current = unique.get(entry.path);
    if (!current || entry.openedAt > current.openedAt) unique.set(entry.path, entry);
  }
  // Archived workspaces are durable history and are never evicted by the active-recency cap.
  return [...unique.values()].sort((left, right) => right.openedAt.localeCompare(left.openedAt));
}

export async function rememberWorkspace(file, workspace, status = null, { preserveArchived = false } = {}) {
  const resolvedPath = path.resolve(workspace.path);
  const canonicalPath = await realpath(resolvedPath).catch(() => resolvedPath);
  const normalized = validateWorkspaceManifest(workspace, { workspaceRoot: canonicalPath });
  const entry = normalizeRegistryEntry({
    id: normalized.id,
    path: normalized.path,
    name: normalized.name,
    anchorKey: normalized.anchor.key,
    anchorType: normalized.anchor.issueTypeName,
    siteId: normalized.anchor.siteId,
    leadRepositoryPath: status?.leadRepositoryPath
      ?? workspaceRepositoryPath(normalized, normalized.repositories[normalized.leadRepository]),
    openedAt: nowIso(),
    archivedAt: null
  });
  return withRegistryMutation(file, async () => {
    const current = await readWorkspaceRegistry(file);
    if (preserveArchived) {
      entry.archivedAt = current.find((item) => item.path === entry.path)?.archivedAt ?? null;
    }
    // Keyed by path, not by identifier: copying a workspace beside itself keeps its id, and both
    // copies are real workspaces. The identifier is therefore not unique, which is why anything
    // resolving by id has to say so when the answer is ambiguous rather than pick one.
    const merged = [entry, ...current.filter((item) => item.path !== entry.path)];
    const active = merged.filter((item) => !item.archivedAt).slice(0, MAX_RECENT_WORKSPACES);
    const archived = merged.filter((item) => item.archivedAt);
    const workspaces = [...active, ...archived];
    await atomicJson(file, { schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION, workspaces });
    return workspaces;
  });
}

export async function forgetWorkspace(file, workspacePath) {
  const resolved = path.resolve(workspacePath);
  const target = await realpath(resolved).catch(() => resolved);
  return withRegistryMutation(file, async () => {
    const workspaces = (await readWorkspaceRegistry(file)).filter((item) => item.path !== target);
    await atomicJson(file, { schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION, workspaces });
    return workspaces;
  });
}

function terminalStory(state) {
  return ['complete', 'cancelled'].includes(String(state?.status ?? '').trim());
}

async function repositoryWorkflowDefinition(repositoryPath) {
  try {
    return YAML.parse(await readFile(path.join(repositoryPath, 'singularity', 'workflow.yml'), 'utf8')) ?? {};
  } catch {
    // The subject index has stable defaults for an uninitialised or partly repaired repository.
    // Archive readiness is about governed Stories, not whether Configuration is otherwise valid.
    return {};
  }
}

/**
 * Prove whether this local workspace may leave the active list.
 *
 * A workspace itself is disposable, but it points at branches that are not. Every ready repository
 * is inspected across its working tree, local branches and remote-tracking branches. A Story is
 * active until it reaches one of the two explicit terminal states: complete or cancelled. Missing
 * repositories and failed refreshes are blockers because "could not inspect" is not evidence that
 * no active work exists.
 */
export async function workspaceArchiveReadiness(workspacePath, {
  fetch = true,
  status: suppliedStatus = null,
  workers = null,
  env = process.env,
  repositoryIds = null
} = {}) {
  const status = suppliedStatus ?? await workspaceStatus(workspacePath, { env });
  const selectedRepositoryIds = repositoryIds == null
    ? null : new Set(repositoryIds.map((id) => String(id)));
  const repositoriesToInspect = selectedRepositoryIds
    ? status.repositories.filter((repository) => selectedRepositoryIds.has(repository.id))
    : status.repositories;
  if (selectedRepositoryIds) {
    const missing = [...selectedRepositoryIds]
      .filter((id) => !status.repositories.some((repository) => repository.id === id));
    if (missing.length) {
      throw new SingularityFlowError(
        `Workspace archive safety cannot inspect unknown repository ${missing.join(', ')}.`,
        { code: 'WORKSPACE_REPOSITORY_UNKNOWN' }
      );
    }
  }
  const inspected = await mapLimit(
    repositoriesToInspect,
    gitWorkerCount(repositoriesToInspect.length, { requested: workers }),
    async (repository) => {
    const record = {
      id: repository.id,
      path: repository.absolutePath,
      state: repository.state,
      refreshed: false,
      stories: 0,
      activeStories: 0
    };
    const blockers = [];
    const activeStories = [];
    if (repository.state !== 'ready') {
      blockers.push(`Repository '${repository.id}' is ${repository.state}; repair it before archiving the workspace.`);
      return { record, blockers, activeStories };
    }

    if (fetch) {
      try {
        // Legacy and explicitly single-branch clones otherwise keep fetching only their original
        // branch. Persist the full branch refspec before the parallel network fetch so remote-only
        // Stories remain visible to the archive safety check.
        if (!prepareRemoteBranchTracking(repository.absolutePath, 'origin', { env })) {
          blockers.push(`Repository '${repository.id}' has no origin remote; repair it before archiving the workspace.`);
          return { record, blockers, activeStories };
        }
      } catch (error) {
        blockers.push(`Repository '${repository.id}' could not prepare origin branch tracking: ${error.message}`);
        return { record, blockers, activeStories };
      }
      const transport = frozenRemoteTransport(repository.url, { env });
      const refreshed = await runRemoteGitAsync([
        'fetch', '--prune', transport.remote,
        '+refs/heads/*:refs/remotes/origin/*'
      ], {
        cwd: repository.absolutePath, operation: 'remote-configuration', env: transport.env
      });
      if (refreshed.status === 0) {
        record.refreshed = true;
      } else {
        blockers.push(`Repository '${repository.id}' could not refresh origin: ${refreshed.failure?.advice ?? 'Git fetch failed.'}`);
        return { record, blockers, activeStories };
      }
    }

    const definition = await repositoryWorkflowDefinition(repository.absolutePath);
    const refs = [
      ...remoteBranches(repository.absolutePath, definition.git?.remote ?? 'origin', { env })
        .map((branch) => ({ branch, ref: `${definition.git?.remote ?? 'origin'}/${branch}` })),
      ...localBranches(repository.absolutePath, { env }).map((branch) => ({ branch, ref: branch }))
    ];
    const indexes = [
      await buildRepositorySubjectIndex(repository.absolutePath, { definition }),
      await buildRepositorySubjectIndexFromRefs(repository.absolutePath, {
        definition, refs, env, fresh: true
      })
    ];
    const seen = new Set();
    const active = new Map();
    for (const index of indexes) {
      for (const unreadable of index.unreadable) {
        blockers.push(`Repository '${repository.id}' has unreadable Story state at ${unreadable.path}: ${unreadable.reason}`);
      }
      for (const subject of index.list('story')) {
        const key = `${repository.id}:${subject.id}`;
        const locations = subject.locations?.length ? subject.locations : [{ state: subject.state }];
        const isActive = locations.some((location) => !terminalStory(location.state));
        if (!seen.has(key)) {
          seen.add(key);
          record.stories += 1;
        }
        if (!isActive) continue;
        active.set(key, {
          repository: repository.id,
          id: subject.id,
          title: subject.state?.workItem?.title ?? subject.id,
          status: subject.state?.status ?? 'unknown',
          phase: subject.state?.currentPhase ?? null,
          branch: subject.canonicalBranch
        });
      }
    }
    activeStories.push(...active.values());
    record.activeStories = activeStories.length;
    return { record, blockers, activeStories };
  });

  const blockers = inspected.flatMap((item) => item.blockers);
  const repositories = inspected.map((item) => item.record);
  const activeStories = inspected.flatMap((item) => item.activeStories).sort((left, right) =>
    left.repository.localeCompare(right.repository) || left.id.localeCompare(right.id));
  return {
    workspace: { id: status.workspace.id, name: status.workspace.name, path: status.workspace.path },
    eligible: blockers.length === 0 && activeStories.length === 0,
    checkedAt: nowIso(),
    fetched: fetch,
    activeStories,
    blockers,
    repositories
  };
}

export async function archiveWorkspace(file, workspacePath, { confirmation, fetch = true } = {}) {
  const workspace = await readWorkspace(workspacePath);
  if (confirmation !== workspace.anchor.key) {
    throw new SingularityFlowError(`Workspace archiving requires exact confirmation '${workspace.anchor.key}'.`);
  }
  const readiness = await workspaceArchiveReadiness(workspace.path, { fetch });
  if (!readiness.eligible) {
    const reasons = [
      ...readiness.activeStories.map((story) =>
        `${story.id} in ${story.repository} is ${story.status}${story.phase ? ` (${story.phase})` : ''}`),
      ...readiness.blockers
    ];
    throw new SingularityFlowError(`Workspace '${workspace.name}' cannot be archived: ${reasons.join(' | ')}`);
  }
  return withRegistryMutation(file, async () => {
    const workspaces = await readWorkspaceRegistry(file);
    const target = workspaces.find((item) => item.path === workspace.path);
    if (!target) throw new SingularityFlowError(`Workspace '${workspace.name}' is not in the local workspace registry.`);
    const archivedAt = nowIso();
    target.archivedAt = archivedAt;
    await atomicJson(file, { schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION, workspaces });
    return { workspace: target, archivedAt, readiness, workspaces };
  });
}

export async function restoreWorkspace(file, workspacePath) {
  const resolved = path.resolve(workspacePath);
  const targetPath = await realpath(resolved).catch(() => resolved);
  return withRegistryMutation(file, async () => {
    const workspaces = await readWorkspaceRegistry(file);
    const target = workspaces.find((item) => item.path === targetPath);
    if (!target) throw new SingularityFlowError('Archived workspace is no longer in the local registry.');
    const restoredAt = nowIso();
    target.archivedAt = null;
    target.openedAt = nowIso();
    await atomicJson(file, { schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION, workspaces });
    return { workspace: target, restoredAt, workspaces };
  });
}

export async function repairWorkspace(workspacePath, {
  workers = null,
  env = process.env,
  cloneOperation = cloneIntoWorkspace,
  adoptionOperation = verifyAdoptionOperation,
  recoverCapabilityDrops = true,
  repositoryIds = null,
  expectedMissingRepositoryIds = []
} = {}) {
  // Finish or roll back a hash-bound local-drop transaction before classifying missing clones.
  // Recovery uses the same manifest lease as detach, so repair cannot race a live transition.
  if (recoverCapabilityDrops) await recoverWorkspaceCapabilityDropTransactions(workspacePath);
  const status = await workspaceStatus(workspacePath);
  const sourceManifestSha256 = workspaceCapabilityChangeSha256(status.workspace);
  const selectedRepositoryIds = repositoryIds == null
    ? null : new Set(repositoryIds.map((id) => String(id)));
  const expectedMissing = new Set(expectedMissingRepositoryIds.map((id) => String(id)));
  if (selectedRepositoryIds) {
    const missing = [...selectedRepositoryIds]
      .filter((id) => !status.repositories.some((repository) => repository.id === id));
    if (missing.length) {
      throw new SingularityFlowError(
        `Workspace repair cannot materialize repository ${missing.join(', ')} because it is no longer in the workspace manifest.`,
        { code: 'WORKSPACE_REPAIR_PLAN_STALE' }
      );
    }
  }
  const unexpectedlyPresent = status.repositories.filter((repository) =>
    expectedMissing.has(repository.id) && repository.state === 'ready');
  if (unexpectedlyPresent.length) {
    throw new SingularityFlowError(
      `A local checkout appeared before SFlow could materialize ${unexpectedlyPresent.map((repository) => repository.id).join(', ')}. It was not adopted or claimed by this workspace; inspect or move it before retrying.`,
      { code: 'WORKSPACE_CAPABILITY_TARGET_EXISTS' }
    );
  }
  const journal = await readRepairJournal(status.workspace, status.repositories);
  const repaired = [];
  const pending = status.repositories.map((repository, index) => ({
    repository, operation: journal.operations[index]
  })).filter(({ repository }) => repository.state !== 'ready'
    && (!selectedRepositoryIds || selectedRepositoryIds.has(repository.id)));
  const gitEnv = pending.length ? enterpriseGitEnvironment(env) : env;
  const unrepairable = pending.find(({ repository }) =>
    !repository.adoption && !['missing', 'empty'].includes(repository.state));
  if (unrepairable) {
    unrepairable.operation.status = 'failed';
    unrepairable.operation.error = `Existing repository directory is ${unrepairable.repository.state}.`;
    unrepairable.operation.completedAt = nowIso();
    await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
    throw new SingularityFlowError(
      `Repository '${unrepairable.repository.id}' requires manual repair because its existing directory is ${unrepairable.repository.state}.`);
  }
  for (const { operation } of pending) {
    operation.status = 'running';
    operation.error = null;
    operation.startedAt = nowIso();
    operation.completedAt = null;
  }
  if (pending.length) await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
  const staged = await mapLimit(
    pending,
    gitWorkerCount(pending.length, { requested: workers }),
    async ({ repository, operation }) => {
      try {
        return repository.adoption
          ? await adoptionOperation(operation)
          : await cloneOperation(status.workspace.path, {
              ...operation,
              bootstrapId: journal.bootstrapId,
              workspaceId: status.workspace.id
            }, { deferClaim: true, env: gitEnv });
      } catch (error) {
        return { status: 1, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
  const claimedStagedResults = new Set();
  try {
  const blockingIndex = pending.findIndex(({ repository }, index) =>
    staged[index].status !== 0 && (repository.required || repository.adoption));
  if (blockingIndex >= 0) {
    const cleanup = await Promise.all(staged.map(discardStagedWorkspaceClone));
    pending.forEach(({ repository, operation }, index) => {
      const result = staged[index];
      const discarded = cleanup[index];
      operation.status = result.status !== 0 ? 'failed'
        : repository.adoption ? 'complete'
          : discarded?.removed ? 'pending' : 'failed';
      operation.error = result.status !== 0 ? result.error
        : repository.adoption ? null
          : discarded?.removed
            ? `Staged clone was discarded because required repository '${pending[blockingIndex].repository.id}' failed.`
            : `Staged clone could not be safely discarded after required repository '${pending[blockingIndex].repository.id}' failed.`
              + `${discarded?.path ? ` Inspect ${discarded.path}.` : ''}`
              + `${discarded?.error ? ` ${discarded.error}` : ''}`;
      operation.adoptionProof = result.adoption ?? null;
      operation.cleanup = discarded;
      operation.completedAt = nowIso();
    });
    await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
    const blocked = pending[blockingIndex];
    const failure = staged[blockingIndex];
    const prefix = blocked.repository.adoption ? 'Adopted repository' : 'Required repository';
    throw new SingularityFlowError(`${prefix} '${blocked.repository.id}' could not be repaired: ${failure.error}`);
  }
  for (let index = 0; index < pending.length; index += 1) {
    const { repository, operation } = pending[index];
    const stagedResult = staged[index];
    const result = stagedResult.status === 0 && stagedResult.claim
      ? await withRegistryFileLease(path.join(status.workspace.path, WORKSPACE_FILE), async () => {
          const current = await readWorkspace(status.workspace.path);
          const currentRepository = current.repositories[repository.id];
          if (workspaceCapabilityChangeSha256(current) !== sourceManifestSha256
              || !currentRepository
              || currentRepository.url !== repository.url
              || currentRepository.defaultBranch !== repository.defaultBranch
              || currentRepository.path !== repository.path) {
            return {
              status: 1,
              error: `Workspace configuration changed while repository '${repository.id}' was cloning. Its staged clone was not claimed; run workspace repair again.`
            };
          }
          return stagedResult.claim();
        }) : stagedResult;
    if (stagedResult.status === 0 && stagedResult.claim && result.status === 0) {
      claimedStagedResults.add(stagedResult);
    }
    if (result.status !== 0) {
      operation.status = 'failed';
      operation.error = result.error;
      operation.completedAt = nowIso();
      await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
      if (repository.required) {
        // Staging can succeed while the final atomic claim loses a race to a newly-created target.
        // Preserve the historic required-repository stop contract and discard only the still-owned
        // staging directories for later entries; already-claimed repositories remain recoverable
        // journal progress, exactly as they did in the former serial repair loop.
        const laterCleanup = await Promise.all(
          staged.slice(index + 1).map(discardStagedWorkspaceClone)
        );
        for (let later = index + 1; later < pending.length; later += 1) {
          const laterOperation = pending[later].operation;
          const laterRepository = pending[later].repository;
          const laterResult = staged[later];
          const discarded = laterCleanup[later - index - 1];
          laterOperation.status = laterResult.status !== 0 ? 'failed'
            : laterRepository.adoption ? 'complete'
              : discarded?.removed ? 'pending' : 'failed';
          laterOperation.error = laterResult.status !== 0 ? laterResult.error
            : laterRepository.adoption ? null
              : discarded?.removed
                ? `Staged clone was discarded because required repository '${repository.id}' failed during final claim.`
                : `Staged clone could not be safely discarded after required repository '${repository.id}' failed during final claim.`
                  + `${discarded?.path ? ` Inspect ${discarded.path}.` : ''}`
                  + `${discarded?.error ? ` ${discarded.error}` : ''}`;
          laterOperation.adoptionProof = laterRepository.adoption
            ? laterResult.adoption ?? null : null;
          laterOperation.cleanup = discarded;
          laterOperation.completedAt = nowIso();
        }
        await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
        throw new SingularityFlowError(
          `Required repository '${repository.id}' could not be repaired: ${result.error}`
        );
      }
      repaired.push({ repository: repository.id, status: 'failed', error: result.error });
    } else if (repository.adoption) {
      operation.status = 'complete';
      operation.error = null;
      operation.adoptionProof = result.adoption ?? null;
      operation.completedAt = nowIso();
      repaired.push({ repository: repository.id, status: 'adopted', proofHash: repository.adoption.proofHash });
      await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
    } else {
      operation.status = 'complete';
      operation.error = null;
      operation.actualClone = result.clone;
      operation.fallbackUsed = result.fallbackUsed;
      operation.cleanup = result.cleanup ?? null;
      operation.completedAt = nowIso();
      repaired.push({
        repository: repository.id,
        status: 'cloned',
        clone: result.clone,
        fallbackUsed: result.fallbackUsed
      });
      await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
    }
  }
  journal.completedAt = journal.operations.every((operation) => operation.status === 'complete' || !operation.required)
    ? nowIso()
    : null;
  await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
  } finally {
    await Promise.all(staged
      .filter((stagedResult) => !claimedStagedResults.has(stagedResult))
      .map(discardStagedWorkspaceClone));
  }
  return { repaired, status: await workspaceStatus(workspacePath) };
}

export async function fetchWorkspace(workspacePath, { env = process.env } = {}) {
  const status = await workspaceStatus(workspacePath);
  const workers = gitWorkerCount(status.repositories.length);
  const results = await mapLimit(status.repositories, workers, async (repository) => {
    if (repository.state !== 'ready') {
      return { repository: repository.id, status: 'skipped', reason: repository.state };
    }
    if (repository.dirty) {
      return { repository: repository.id, status: 'skipped', reason: 'dirty' };
    }
    const transport = frozenRemoteTransport(repository.url, { env });
    const result = await runRemoteGitAsync([
      'fetch', '--prune', transport.remote,
      '+refs/heads/*:refs/remotes/origin/*'
    ], {
      cwd: repository.absolutePath, operation: 'remote-configuration', env: transport.env
    });
    return {
      repository: repository.id,
      status: result.status === 0 ? 'fetched' : 'failed',
      error: result.status === 0 ? null : result.failure?.advice ?? 'Git fetch failed.'
    };
  });
  return { fetchedAt: nowIso(), results, status: await workspaceStatus(workspacePath) };
}
