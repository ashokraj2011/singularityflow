/**
 * Workspace manifests (`workspace.json`), the checkout each of their repositories resolves to, and
 * the machine registry that indexes them: the read and validation side only.
 *
 * workspace.mjs owns creation, materialization, status and registry writes, and with them the
 * remote Git, clone-transport and enterprise-environment graph. It imports these readers instead of
 * keeping its own, so a context read (Help metrics, prompt audit, workspace membership) validates a
 * saved workspace exactly as workspace.mjs does without loading that graph.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { normalizeCloneStrategy } from './clone-strategy.mjs';
import { assertCredentialFreeRemote, sanitizeRemote } from './git-remote-diagnostics.mjs';
import { normalizeRepositoryMetadata } from './repository-metadata.mjs';
import { readRecord } from './schema-migrations.mjs';
import { isGitRefName, portableIdentifier, SingularityFlowError } from './util.mjs';
import { assertProposedWorkspaceRepositoryPaths } from './workspace-repository-paths.mjs';

export const WORKSPACE_FILE = 'workspace.json';
export const WORKSPACE_SCHEMA_VERSION = 1;
function nowIso() { return new Date().toISOString(); }

export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${label} must be an object.`);
  return value;
}

export function safeId(value, label) {
  return portableIdentifier(value, label);
}

export function safeRelative(value, label) {
  const relative = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new SingularityFlowError(`${label} must stay inside the workspace.`);
  return relative;
}

export function safeUnder(value, root, label) {
  const relative = safeRelative(value, label);
  if (!relative.startsWith(`${root}/`)) throw new SingularityFlowError(`${label} must live below ${root}/.`);
  return relative;
}

function safeRootOrUnder(value, root, label) {
  const relative = safeRelative(value, label);
  if (relative !== root && !relative.startsWith(`${root}/`)) throw new SingularityFlowError(`${label} must be ${root}/ or live below it.`);
  return relative;
}

export function storableRemote(value, { redactCredentials = false } = {}) {
  try { return assertCredentialFreeRemote(value); }
  catch (error) {
    if (!redactCredentials) throw error;
    return assertCredentialFreeRemote(sanitizeRemote(value));
  }
}

export function portableName(value) {
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

export function normalizeRepository(id, input) {
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
  const clonePolicySource = repository.clonePolicySource == null
    ? null : String(repository.clonePolicySource);
  if (clonePolicySource != null
      && !['portfolio-declared', 'workspace-override'].includes(clonePolicySource)) {
    throw new SingularityFlowError(
      `Workspace repository '${id}' has an unsupported clone policy source.`
    );
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
    ...(clonePolicySource ? { clonePolicySource } : {}),
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

export function validateWorkspaceManifest(input, {
  workspaceRoot = null, previousManifest = null, preserveLegacyPaths = false
} = {}) {
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
  if (!preserveLegacyPaths) {
    assertProposedWorkspaceRepositoryPaths(rawRepositories, { previous: previousManifest });
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
  return validateWorkspaceManifest(parsed, {
    workspaceRoot: path.dirname(file), preserveLegacyPaths: true
  });
}

export function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.path !== 'string' || !entry.path.trim()) return null;
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

function invalidWorkspaceRegistry(file, reason, cause = undefined) {
  const registryFile = path.resolve(file);
  return new SingularityFlowError(
    `The local workspace registry is unreadable or invalid: ${registryFile}. Repair or remove it before retrying.`,
    {
      code: 'WORKSPACE_REGISTRY_INVALID',
      details: { registryFile, reason },
      cause
    }
  );
}

export async function readWorkspaceRegistry(file) {
  let contents;
  try { contents = await readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw invalidWorkspaceRegistry(file, 'unreadable', error);
  }
  let parsed;
  try { parsed = JSON.parse(contents); }
  catch (error) { throw invalidWorkspaceRegistry(file, 'malformed-json', error); }
  if (!Array.isArray(parsed)) {
    try { parsed = readRecord('workspace-registry', parsed).record; }
    catch (error) { throw invalidWorkspaceRegistry(file, 'invalid-record', error); }
  }
  const values = Array.isArray(parsed) ? parsed : parsed?.workspaces;
  if (!Array.isArray(values)) throw invalidWorkspaceRegistry(file, 'invalid-shape');
  const unique = new Map();
  for (const value of values) {
    const entry = normalizeRegistryEntry(value);
    if (!entry) throw invalidWorkspaceRegistry(file, 'invalid-entry');
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
