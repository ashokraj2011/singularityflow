import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeRepositoryMetadata } from './repository-metadata.mjs';
import { localBranches, prepareRemoteBranchTracking, remoteBranches } from './git.mjs';
import {
  buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs
} from './repository-subject-index.mjs';
import { gitWorkerCount, isGitRefName, mapLimit, SingularityFlowError, run } from './util.mjs';
import {
  classifyPartialCloneResult, cloneStrategyArguments, normalizeCloneStrategy, partialCloneConfigured
} from './clone-strategy.mjs';
import {
  assertCredentialFreeRemote, classifyGitRemoteFailure, frozenRemoteTransport,
  remoteFingerprint, sanitizeRemote
} from './git-remote-diagnostics.mjs';
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
const registryMutationTails = new Map();
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const REGISTRY_LOCK_STALE_MS = 15 * 60_000;

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

async function withRegistryFileLease(file, operation) {
  const lock = `${path.resolve(file)}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  const started = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(lock, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: nowIso() })}\n`);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > REGISTRY_LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() - started >= REGISTRY_LOCK_TIMEOUT_MS) {
        throw new SingularityFlowError(
          'The local workspace registry is busy in another process. Retry the same command.',
          { code: 'WORKSPACE_REGISTRY_BUSY' }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await rm(lock, { force: true }).catch(() => {});
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
  const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(symrefOutput ?? '');
  if (symref?.[1]) return symref[1];

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

  const session = new GitRemoteSession({ env });
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
  remoteSession = new GitRemoteSession({ env })
} = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A repository URL is required.');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-lead-map-'));
  try {
    // Partial clones are refused by some servers and by older Git; without the filter this still
    // works, it just fetches one commit's blobs.
    // Organisation configuration is intentionally independent of application `main`. Workspaces
    // must therefore read the approved configuration branch, never whichever application branch
    // the remote happens to advertise as HEAD.
    const configured = await remoteSession.observeAsync(remote, {
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
    const transport = frozenRemoteTransport(remote, { env });
    const clone = (extra) => runRemoteGitAsync([
      'clone', '--quiet', '--depth', '1', '--no-checkout', '--branch', branch, ...extra,
      transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    let cloned = await clone(['--filter=blob:none']);
    const partial = classifyPartialCloneResult(cloned, {
      configured: cloned.status === 0
        ? partialCloneConfigured(scratch, 'origin', (args, options) => run('git', args, {
            ...options, env: transport.env
          }))
        : null
    });
    // Retry only a server's explicit filter-capability refusal. Replaying authentication, proxy,
    // TLS, timeout, or generic network failures as a full clone doubles the office wait and cannot
    // make those failures succeed. A successful clone that ignored the filter is already the full
    // catalog checkout we need, so retain it rather than downloading it again.
    if (cloned.status !== 0 && partial.kind === 'filter-rejected') {
      await rm(scratch, { recursive: true, force: true });
      await mkdir(scratch, { recursive: true });
      cloned = await clone([]);
    }
    if (cloned.status !== 0) {
      throw new SingularityFlowError(`Cannot read '${remote}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`);
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
  remoteSession = new GitRemoteSession({ env })
} = {}) {
  const workspaceCapabilities = [...new Set(manifest.capabilities ?? [])].sort();
  const repositoryCapabilities = Object.values(manifest.repositories ?? {})
    .flatMap((repository) => repository.capabilities ?? []);
  const requested = [...new Set([...workspaceCapabilities, ...repositoryCapabilities])].sort();
  if (!requested.length) {
    return { checked: false, requested: [], known: [], branch: null, path: null };
  }

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
      const observed = await remoteSession.observeAsync(remote, {
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
    catalog = await readCapabilities(authorityUrl, { env, remoteSession });
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
  await atomicJson(path.join(preview.root, WORKSPACE_FILE), preview.manifest);
  try {
    const repaired = await repairWorkspace(preview.root);
    return {
      updated: true,
      workspace: repaired.status.workspace,
      status: repaired.status,
      repair: repaired.repaired,
      materializationError: null
    };
  } catch (error) {
    return {
      updated: true,
      workspace: await readWorkspace(preview.root),
      status: await workspaceStatus(preview.root),
      repair: [],
      materializationError: error?.message || String(error)
    };
  }
}

function gitValue(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
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
  const classified = classifyGitRemoteFailure(result, { branch: operation.branch });
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
  const transport = frozenRemoteTransport(operation.url, { env });
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
  let partial = selected.mode === 'full' ? null : classifyPartialCloneResult(result, {
    configured: result.status === 0
      ? partialCloneConfigured(staging, 'origin', (args, options) => run('git', args, {
          ...options, env: transport.env
        }))
      : null
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
    if (selected.mode === 'full' || selected.fallback !== 'full' || partial?.kind !== 'filter-rejected') {
      return { status: result.status, error: await cleanupFailure(cloneFailure(operation, result)) };
    }
    const fallbackFailure = await cloneFullOnce();
    if (fallbackFailure) return fallbackFailure;
    partial = null;
  }

  if (selected.mode !== 'full' && partial?.kind === 'filter-ignored') {
    if (selected.fallback !== 'full') {
      return {
        status: 1,
        error: await cleanupFailure(`Repository '${operation.repository}' did not establish a blobless partial clone. `
          + `The server may not support filter=blob:none; clone fallback is 'refuse', so a full monorepo was not retained.`)
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
            error: await cleanupFailure(`Repository '${operation.repository}' downloaded a complete clone but Git could not disable its sparse checkout: `
              + `${String(expanded.stderr || expanded.stdout).trim() || 'Git refused to expand the working tree'}.`)
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
          + `${strategy.sparseCone.join(', ')}: ${String(sparse.stderr || sparse.stdout).trim() || 'Git refused the cone paths'}.`)
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
  const confirmationLabel = manifest.anchor.provider === 'jira' ? 'Jira-key' : 'workspace-ID';
  if (confirmation !== manifest.anchor.key) throw new SingularityFlowError(`Workspace creation requires exact ${confirmationLabel} confirmation '${manifest.anchor.key}'.`);
  // Authority is checked after the exact human confirmation but before even the workspace parent
  // directory is created. An invalid capability selection therefore leaves no shell, manifest, or
  // repair journal behind for a later command to mistake for a resumable workspace.
  await validateWorkspaceCapabilityRegistration(manifest, { receipt: capabilityValidation, env });
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
        workers, cloneOperation, adoptionOperation, env
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
                  }, { deferClaim: true, env });
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
    return {
      state: 'missing',
      exists: false,
      outputDirectory: normalizedOutput,
      manifestPath,
      generatedAt: null,
      warning: `No repository world model was found at ${manifestPath}.`
    };
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

async function repositoryStatus(root, repository, { level = 'full' } = {}) {
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
        ? '--untracked-files=no' : '--untracked-files=all']),
    gitValueAsync(absolute, ['branch', '--show-current']),
    // Read the durable identity rather than Git's operationally rewritten URL. Workspace transports
    // freeze this exact value per invocation; ambient url.* rules are neither manifest authority nor
    // permission to make an otherwise correct clone look permanently misconfigured.
    gitValueAsync(absolute, ['config', '--local', '--get', 'remote.origin.url']),
    gitValueAsync(absolute, ['rev-parse', 'HEAD'])
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

export async function workspaceStatus(workspacePath, { level = 'full' } = {}) {
  if (!['readiness', 'summary', 'full'].includes(level)) {
    throw new SingularityFlowError(`Unknown workspace status level '${level}'.`);
  }
  const workspace = await readWorkspace(workspacePath);
  const repositories = await Promise.all(Object.values(workspace.repositories).map((repository) =>
    repositoryStatus(workspace.path, repository, { level })));
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
  env = process.env
} = {}) {
  const status = suppliedStatus ?? await workspaceStatus(workspacePath);
  const inspected = await mapLimit(
    status.repositories,
    gitWorkerCount(status.repositories.length, { requested: workers }),
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
        if (!prepareRemoteBranchTracking(repository.absolutePath, 'origin')) {
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
      ...remoteBranches(repository.absolutePath, definition.git?.remote ?? 'origin')
        .map((branch) => ({ branch, ref: `${definition.git?.remote ?? 'origin'}/${branch}` })),
      ...localBranches(repository.absolutePath).map((branch) => ({ branch, ref: branch }))
    ];
    const indexes = [
      await buildRepositorySubjectIndex(repository.absolutePath, { definition }),
      await buildRepositorySubjectIndexFromRefs(repository.absolutePath, { definition, refs })
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
  adoptionOperation = verifyAdoptionOperation
} = {}) {
  const status = await workspaceStatus(workspacePath);
  const journal = await readRepairJournal(status.workspace, status.repositories);
  const repaired = [];
  const pending = status.repositories.map((repository, index) => ({
    repository, operation: journal.operations[index]
  })).filter(({ repository }) => repository.state !== 'ready');
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
            }, { deferClaim: true, env });
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
      ? await stagedResult.claim() : stagedResult;
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
