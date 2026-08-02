import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeRepositoryMetadata } from './repository-metadata.mjs';
import { SingularityFlowError, run } from './util.mjs';

export const WORKSPACE_FILE = 'workspace.json';
export const WORKSPACE_SCHEMA_VERSION = 1;
export const MAX_RECENT_WORKSPACES = 20;
const registryMutationTails = new Map();

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
  if (repository.url.trim().startsWith('-') || repository.url.trim().startsWith('ext::')) {
    throw new SingularityFlowError(`Workspace repository '${id}' uses an unsafe clone URL.`);
  }
  const defaultBranch = String(repository.defaultBranch ?? 'main').trim() || 'main';
  if (!/^(?![./])(?!.*(?:\.\.|@\{|[~^:?*\\\[]))(?!.*\/\.)(?!.*[/.]$)[^\s\x00-\x1f\x7f]+$/.test(defaultBranch)) {
    throw new SingularityFlowError(`Workspace repository '${id}' has an invalid default branch.`);
  }
  return {
    id,
    url: repository.url.trim(),
    defaultBranch,
    required: repository.required !== false,
    metadata: normalizeRepositoryMetadata(repository.metadata ?? {}, `Workspace repository '${id}' metadata`),
    jira: normalizeRepositoryJira(repository.jira ?? {}, `Workspace repository '${id}' Jira configuration`),
    path: relativePath,
    role: repository.role === 'lead' ? 'lead' : 'participant'
  };
}

export function validateWorkspaceManifest(input, { workspaceRoot = null } = {}) {
  const manifest = object(structuredClone(input), 'Workspace manifest');
  if (manifest.version !== WORKSPACE_SCHEMA_VERSION) throw new SingularityFlowError(`Workspace manifest version must be ${WORKSPACE_SCHEMA_VERSION}.`);
  manifest.anchor = normalizeWorkspaceAnchor(manifest.anchor);
  manifest.id = manifest.id ?? `${manifest.anchor.siteId}--${manifest.anchor.key}`;
  safeId(manifest.id, 'Workspace ID');
  manifest.name = String(manifest.name ?? `${manifest.anchor.key} — ${manifest.anchor.title}`).trim();
  manifest.leadRepository = safeId(manifest.leadRepository, 'Lead repository ID');
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

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function withRegistryMutation(file, operation) {
  const key = path.resolve(file);
  const previous = registryMutationTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
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
    repositories: Object.fromEntries(Object.entries(manifest.repositories).map(([id, repository]) => [id, {
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      required: repository.required,
      metadata: repository.metadata,
      jira: repository.jira,
      path: repository.path,
      role: repository.role
    }])),
    directories: manifest.directories
  });
}

function sameWorkspaceMaterializationPlan(left, right) {
  return JSON.stringify(workspaceMaterializationPlan(left)) === JSON.stringify(workspaceMaterializationPlan(right));
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
  baseDirectory, anchor, name, repositories, leadRepository, capabilities
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
      repositories: normalized,
      capabilities,
      createdAt: nowIso(),
      updatedAt: nowIso()
    }, { workspaceRoot: root }),
    operations: Object.values(normalized).map((repository) => ({
      action: 'clone',
      repository: repository.id,
      url: repository.url,
      target: path.join(root, repository.path),
      branch: repository.defaultBranch,
      required: repository.required
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
 * This lived in the Electron layer, so the CLI and the editor could not use it and would each have
 * needed their own copy of these rules. It belongs to the engine for the same reason
 * `extractSourceText` did.
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

  const remoteHead = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    allowFailure: true
  }).stdout.trim();
  const defaultBranch = remoteHead.replace(/^origin\//, '') || 'main';

  const id = path.basename(root)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'repository';

  return {
    id,
    localPath: root,
    url: origin,
    defaultBranch,
    required: true,
    jira: { board: '' },
    metadata: { name: path.basename(root), appId: '' }
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
export function remoteDefaultBranch(remote, symrefOutput) {
  const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(symrefOutput ?? '');
  if (symref?.[1]) return symref[1];

  const heads = run('git', ['ls-remote', '--heads', remote], { allowFailure: true });
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

export async function workspaceRemoteDefaults(url, { stateBranch = 'state' } = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A repository URL is required.');
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(remote) && !remote.startsWith('/')) {
    throw new SingularityFlowError(`'${remote}' is not a clone URL. Use https://, git@, ssh:// or an absolute path.`);
  }

  const head = run('git', ['ls-remote', '--symref', remote, 'HEAD'], { allowFailure: true });
  if (head.status !== 0) {
    throw new SingularityFlowError(`Cannot reach '${remote}': ${(head.stderr || head.stdout).trim().split('\n')[0]}`);
  }
  const defaultBranch = remoteDefaultBranch(remote, head.stdout);

  const state = run('git', ['ls-remote', '--heads', remote, stateBranch], { allowFailure: true });
  const hasStateBranch = state.status === 0 && Boolean(state.stdout.trim());

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
  portfolioPath = 'singularity/portfolio.yml'
} = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A repository URL is required.');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-lead-map-'));
  try {
    // Partial clones are refused by some servers and by older Git; without the filter this still
    // works, it just fetches one commit's blobs.
    // Named explicitly rather than left to HEAD: a remote whose HEAD points at a branch that never
    // existed clones with nothing to resolve, and `git show HEAD:` then reports the map as absent
    // when it is right there on the only branch the repository has.
    const branch = remoteDefaultBranch(remote, run('git', ['ls-remote', '--symref', remote, 'HEAD'], { allowFailure: true }).stdout);
    const clone = (extra) => run('git', [
      'clone', '--quiet', '--depth', '1', '--no-checkout', '--branch', branch, ...extra, remote, scratch
    ], { allowFailure: true });
    let cloned = clone(['--filter=blob:none']);
    if (cloned.status !== 0) {
      await rm(scratch, { recursive: true, force: true });
      await mkdir(scratch, { recursive: true });
      cloned = clone([]);
    }
    if (cloned.status !== 0) {
      throw new SingularityFlowError(`Cannot read '${remote}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`);
    }

    const shown = run('git', ['show', `HEAD:${capabilitiesPath}`], { cwd: scratch, allowFailure: true });
    if (shown.status !== 0) {
      return { capabilities: null, deliveries: [], reason: `${remote} does not contain ${capabilitiesPath}.`, path: capabilitiesPath };
    }

    // The map names repository identifiers; the portfolio is what turns those into somewhere to
    // clone from. Read in the same fetch, because a capability you cannot clone is not a choice.
    const portfolioText = run('git', ['show', `HEAD:${portfolioPath}`], { cwd: scratch, allowFailure: true });
    const portfolio = portfolioText.status === 0 ? (YAML.parse(portfolioText.stdout)?.repositories ?? {}) : {};

    const { capabilityTree, flattenCapabilityTree, validateCapabilities } = await import('./capabilities.mjs');
    const definition = validateCapabilities(YAML.parse(shown.stdout));
    const tree = capabilityTree(definition);
    return {
      capabilities: tree,
      // Flat, because the caller's next question is always "which repositories is that?".
      deliveries: flattenCapabilityTree(tree)
        .filter((row) => row.repository)
        .map((row) => ({
          id: row.id,
          name: row.name,
          repository: row.repository,
          ancestors: row.ancestors,
          // Null when the capability names a repository the portfolio does not declare — a real
          // state, and one the person choosing needs to see rather than discover at clone time.
          url: portfolio[row.repository]?.url ?? null,
          defaultBranch: portfolio[row.repository]?.defaultBranch ?? 'main'
        })),
      reason: null,
      path: capabilitiesPath
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function previewWorkspaceConfiguration({
  baseDirectory, id, name, repositories, leadRepository, capabilities
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
    capabilities
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
    capabilities: preview.manifest.capabilities
  }, settings);
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
      target: path.join(current.path, repository.path),
      branch: repository.defaultBranch,
      required: repository.required
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
    capabilities: source.capabilities ?? [],
    repositories: Object.fromEntries(Object.entries(source.repositories).map(([key, repository]) => [key, {
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      required: repository.required,
      metadata: repository.metadata,
      jira: repository.jira,
      path: repository.path
    }]))
  });
  await assertWorkingDirectoryFree(preview.root);

  return createWorkspaceConfiguration({
    baseDirectory: base,
    id: workspaceId,
    name: name ?? workspaceId,
    leadRepository: source.leadRepository,
    capabilities: source.capabilities ?? [],
    repositories: preview.manifest.repositories
  }, { ...settings, confirmation: workspaceId });
}

export async function updateWorkspaceConfiguration(workspacePath, options, { confirmation } = {}) {
  const preview = await previewWorkspaceUpdate(workspacePath, options);
  if (confirmation !== preview.manifest.anchor.key) {
    throw new SingularityFlowError(`Workspace editing requires exact workspace confirmation '${preview.manifest.anchor.key}'.`);
  }
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

async function writeJournal(root, journal, logsDirectory = 'logs') {
  const file = path.join(root, logsDirectory, 'workspace-materialization.json');
  await assertInside(root, file);
  await atomicJson(file, journal);
}

function materializationOperation(root, repository) {
  return {
    action: 'clone',
    repository: repository.id,
    url: repository.url,
    target: path.join(root, repository.path),
    branch: repository.defaultBranch,
    required: repository.required
  };
}

async function cloneIntoWorkspace(root, operation) {
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
  const stagingRoot = await mkdtemp(path.join(parent, '.sflow-clone-'));
  const staging = path.join(stagingRoot, 'repository');
  await assertInside(root, staging);
  // Check out the configured default branch, but retain remote-tracking refs for governed Epic
  // and Story branches. State transfer depends on seeing branches created from other terminals.
  const result = run('git', ['clone', '--branch', operation.branch, '--', operation.url, staging], {
    cwd: root,
    allowFailure: true
  });
  if (result.status !== 0) {
    await rm(stagingRoot, { recursive: true, force: true });
    return { status: result.status, error: (result.stderr || result.stdout).trim() };
  }
  try {
    // A user may pre-create the repository folder while setting up a workspace. Claim it only
    // when it is still empty after the clone completes; rmdir fails if a concurrent process
    // added anything, so no user content is overwritten.
    if (existing) await rmdir(operation.target);
    await rename(staging, operation.target);
    await rm(stagingRoot, { recursive: true, force: true });
    return { status: 0, error: null };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    return { status: 1, error: `Clone completed but could not claim its workspace target: ${error.message}` };
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
  clone = true
} = {}) {
  const preview = previewWorkspace(options);
  const { root, manifest } = preview;
  const confirmationLabel = manifest.anchor.provider === 'jira' ? 'Jira-key' : 'workspace-ID';
  if (confirmation !== manifest.anchor.key) throw new SingularityFlowError(`Workspace creation requires exact ${confirmationLabel} confirmation '${manifest.anchor.key}'.`);
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
      const repaired = await repairWorkspace(current.path);
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
      await writeJournal(root, journal, manifest.directories.logs);
      const result = await cloneIntoWorkspace(root, operation);
      operation.status = result.status === 0 ? 'complete' : 'failed';
      operation.error = result.error;
      operation.completedAt = nowIso();
      await writeJournal(root, journal, manifest.directories.logs);
      if (result.status !== 0 && operation.required) {
        throw new SingularityFlowError(`Workspace retained for repair after ${operation.repository} clone failed: ${operation.error}`);
      }
    }
    journal.completedAt = nowIso();
    await writeJournal(root, journal, manifest.directories.logs);
  }
  const finalStatus = await workspaceStatus(root);
  return { created: true, resumed: false, workspace: finalStatus.workspace, status: finalStatus };
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

async function repositoryStatus(root, repository) {
  const absolute = path.join(root, repository.path);
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
  const dirty = Boolean(gitValue(absolute, ['status', '--porcelain=v1', '--untracked-files=all']));
  const branch = gitValue(absolute, ['branch', '--show-current']);
  const remote = gitValue(absolute, ['remote', 'get-url', 'origin']);
  return {
    ...repository,
    absolutePath: absolute,
    state: remote === repository.url ? 'ready' : 'remote-mismatch',
    dirty,
    branch,
    remote,
    head: gitValue(absolute, ['rev-parse', 'HEAD']),
    worldModel: await repositoryWorldModelStatus(absolute)
  };
}

export async function workspaceStatus(workspacePath) {
  const workspace = await readWorkspace(workspacePath);
  const repositories = await Promise.all(Object.values(workspace.repositories).map((repository) => repositoryStatus(workspace.path, repository)));
  const staged = await listWorkspaceDocuments(workspace.path);
  const warnings = repositories
    .filter((repository) => repository.state === 'ready' && repository.worldModel?.warning)
    .map((repository) => ({
      code: repository.worldModel.state === 'missing' ? 'world-model-missing' : 'world-model-invalid',
      repository: repository.id,
      message: `${repository.metadata?.name ?? repository.id}: ${repository.worldModel.warning}`
    }));
  return {
    workspace,
    healthy: repositories.every((repository) => repository.state === 'ready'),
    leadRepositoryPath: path.join(workspace.path, workspace.repositories[workspace.leadRepository].path),
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
  return [...unique.values()].sort((left, right) => right.openedAt.localeCompare(left.openedAt)).slice(0, MAX_RECENT_WORKSPACES);
}

export async function rememberWorkspace(file, workspace, status = null) {
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
    leadRepositoryPath: status?.leadRepositoryPath ?? path.join(normalized.path, normalized.repositories[normalized.leadRepository].path),
    openedAt: nowIso(),
    archivedAt: null
  });
  return withRegistryMutation(file, async () => {
    const current = await readWorkspaceRegistry(file);
    const workspaces = [entry, ...current.filter((item) => item.path !== entry.path)].slice(0, MAX_RECENT_WORKSPACES);
    await atomicJson(file, { schemaVersion: 1, workspaces });
    return workspaces;
  });
}

export async function forgetWorkspace(file, workspacePath) {
  const resolved = path.resolve(workspacePath);
  const target = await realpath(resolved).catch(() => resolved);
  return withRegistryMutation(file, async () => {
    const workspaces = (await readWorkspaceRegistry(file)).filter((item) => item.path !== target);
    await atomicJson(file, { schemaVersion: 1, workspaces });
    return workspaces;
  });
}

export async function archiveWorkspace(file, workspacePath, { confirmation } = {}) {
  const workspace = await readWorkspace(workspacePath);
  if (confirmation !== workspace.anchor.key) {
    throw new SingularityFlowError(`Workspace archiving requires exact confirmation '${workspace.anchor.key}'.`);
  }
  return withRegistryMutation(file, async () => {
    const workspaces = await readWorkspaceRegistry(file);
    const target = workspaces.find((item) => item.path === workspace.path);
    if (!target) throw new SingularityFlowError(`Workspace '${workspace.name}' is not in the local workspace registry.`);
    target.archivedAt = nowIso();
    await atomicJson(file, { schemaVersion: 1, workspaces });
    return workspaces;
  });
}

export async function restoreWorkspace(file, workspacePath) {
  const resolved = path.resolve(workspacePath);
  const targetPath = await realpath(resolved).catch(() => resolved);
  return withRegistryMutation(file, async () => {
    const workspaces = await readWorkspaceRegistry(file);
    const target = workspaces.find((item) => item.path === targetPath);
    if (!target) throw new SingularityFlowError('Archived workspace is no longer in the local registry.');
    target.archivedAt = null;
    target.openedAt = nowIso();
    await atomicJson(file, { schemaVersion: 1, workspaces });
    return workspaces;
  });
}

export async function repairWorkspace(workspacePath) {
  const status = await workspaceStatus(workspacePath);
  const journal = await readRepairJournal(status.workspace, status.repositories);
  const repaired = [];
  for (let index = 0; index < status.repositories.length; index += 1) {
    const repository = status.repositories[index];
    const operation = journal.operations[index];
    if (repository.state === 'ready') continue;
    if (!['missing', 'empty'].includes(repository.state)) {
      operation.status = 'failed';
      operation.error = `Existing repository directory is ${repository.state}.`;
      operation.completedAt = nowIso();
      await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
      throw new SingularityFlowError(`Repository '${repository.id}' requires manual repair because its existing directory is ${repository.state}.`);
    }
    operation.status = 'running';
    operation.error = null;
    operation.startedAt = nowIso();
    operation.completedAt = null;
    await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
    const result = await cloneIntoWorkspace(status.workspace.path, operation);
    if (result.status !== 0) {
      operation.status = 'failed';
      operation.error = result.error;
      operation.completedAt = nowIso();
      await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
      if (repository.required) throw new SingularityFlowError(`Required repository '${repository.id}' could not be repaired: ${result.error}`);
      repaired.push({ repository: repository.id, status: 'failed', error: result.error });
    } else {
      operation.status = 'complete';
      operation.error = null;
      operation.completedAt = nowIso();
      repaired.push({ repository: repository.id, status: 'cloned' });
      await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
    }
  }
  journal.completedAt = journal.operations.every((operation) => operation.status === 'complete' || !operation.required)
    ? nowIso()
    : null;
  await writeJournal(status.workspace.path, journal, status.workspace.directories.logs);
  return { repaired, status: await workspaceStatus(workspacePath) };
}

export async function fetchWorkspace(workspacePath) {
  const status = await workspaceStatus(workspacePath);
  const results = [];
  for (const repository of status.repositories) {
    if (repository.state !== 'ready') {
      results.push({ repository: repository.id, status: 'skipped', reason: repository.state });
      continue;
    }
    if (repository.dirty) {
      results.push({ repository: repository.id, status: 'skipped', reason: 'dirty' });
      continue;
    }
    const result = run('git', ['fetch', '--prune', 'origin'], { cwd: repository.absolutePath, allowFailure: true });
    results.push({
      repository: repository.id,
      status: result.status === 0 ? 'fetched' : 'failed',
      error: result.status === 0 ? null : (result.stderr || result.stdout).trim()
    });
  }
  return { fetchedAt: nowIso(), results, status: await workspaceStatus(workspacePath) };
}
