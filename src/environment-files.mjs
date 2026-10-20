/**
 * Environment files [ENVF] (docs/SPEC-ENVIRONMENT-FILES-v1.md): where each environment's files are on
 * this machine, and placing them into a checkout for a run.
 *
 * An exact `localFiles` path of `singularity/environments.yml`, or a personal path a person added, is
 * an environment file. Its real file resolves, in order, to a linked location (`env files link`), the
 * workspace's folder for the environment (`<root>/<repository-id>/<path>`), or the repository's
 * private store below the Git common directory, shared by every worktree. The registry beside the
 * store records paths and metadata only; nothing here reads, stores, hashes or prints a file's
 * contents, except a template's bytes copied into a new private file and the bounded value read for
 * a run's redactor (environment-files-values.mjs).
 *
 * Placing a file makes its path a symbolic link to the real file (a refreshed, noted copy on
 * Windows), excluded once in the clone's `.git/info/exclude`. A regular file already at the path is
 * never overwritten ("unmanaged"), a tracked one is a declaration error, and a missing one refuses
 * the run before anything starts with ENV_FILE_MISSING naming both fixes. Files outside every
 * repository (a multi-repository workspace's root `.env`) live in a workspace-level store beside
 * the workspace registry, never in Git.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  appendFile, chmod, copyFile, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, stat, symlink, unlink
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ENVIRONMENT_IDENTIFIER, isExactEnvironmentFilePath, loadEnvironmentDeclaration } from './environment-declaration.mjs';
import { repositoryGitDirectory } from './git-directory.mjs';
import { gitCommonDir, trackedPaths } from './git.mjs';
import {
  listPrivateSidecar, readPrivateSidecar, safePrivateSidecarDirectory, writeMutablePrivateSidecar
} from './private-sidecar.mjs';
import { ensureSecureRepositoryDirectory, secureRepositoryPath, SingularityFlowError } from './util.mjs';

// Record versions these readers accept, as environment bindings keep theirs (machine-local records only).
const supportedRecordVersions = Object.freeze({ 1: true });
const MAXIMUM_RECORD_BYTES = 256 * 1024;
const MAXIMUM_TEMPLATE_BYTES = 1024 * 1024;
const MAXIMUM_ENTRIES = 1_024;
const TEMPLATE_MARKERS = Object.freeze(['example', 'template', 'sample']);
const SOURCES = Object.freeze(['store', 'linked', 'root']);
const ORIGINS = Object.freeze(['declared', 'personal']);
const ENTRY_KEYS = Object.freeze(['environment', 'path', 'origin', 'source', 'linkedPath', 'createdAt', 'changedAt']);
// A workspace folder keeps workspace-level files beside the repositories' folders; a repository ID
// never starts with a dot, so this name cannot collide with one.
const WORKSPACE_FOLDER = '.workspace';
export const EXCLUDE_COMMENT = '# Singularity Flow (singularity-flow env files): machine-local environment files, never commit them';

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

const notFound = (error) => (['ENOENT', 'ENOTDIR'].includes(error?.code) ? null : Promise.reject(error));
const isoNow = () => new Date().toISOString();

/** A word for a shell: quoted only when it holds a character a shell would read. */
export function shellWord(value) {
  const text = String(value);
  return /^[A-Za-z0-9._/@:+=,%-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

export function environmentArgument(value) {
  if (typeof value !== 'string' || !ENVIRONMENT_IDENTIFIER.test(value)) {
    fail(`Environment '${value ?? ''}' is not a valid environment ID (lower-kebab-case, at most 64 characters).`, 'ENV_FILES_INVALID');
  }
  return value;
}

/** A repository- or workspace-relative exact file path, as a person types it on any platform. */
export function filePathArgument(value) {
  const relative = String(value ?? '').replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '');
  if (!isExactEnvironmentFilePath(relative)) {
    fail(`'${value ?? ''}' is not an exact relative file path: no glob characters, '..', '.git', or absolute path.`, 'ENV_FILES_INVALID', { path: String(value ?? '') });
  }
  return relative;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Names of a declaration's exact localFiles for one environment: the files SFlow can create and place. */
export function declaredEnvironmentFiles(declaration, environment) {
  return (declaration?.environments?.[environment]?.localFiles ?? []).filter(isExactEnvironmentFilePath);
}

// ---------------------------------------------------------------------------------------------
// Locations.

/** The repository's private store, shared by every worktree of the clone. */
export function environmentFilesStore(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'environment-files', 'v1');
}

/** Machine-local workspace-level state: beside the workspace registry, never in a checkout. */
export function workspaceFilesBase(env = process.env) {
  const registry = env.SINGULARITY_FLOW_WORKSPACE_REGISTRY || path.join(os.homedir(), '.singularity-flow', 'workspaces.json');
  return path.join(path.dirname(path.resolve(registry)), 'environment-files', 'v1');
}

/** Whether this machine has any workspace-level environment-file state (one lstat; nothing else is read). */
export async function workspaceFilesStateExists() {
  return Boolean(await lstat(workspaceFilesBase()).catch(() => null));
}

// ---------------------------------------------------------------------------------------------
// Machine-private files outside Git (workspace-level store, registry and folder settings).

async function windowsPrivate(target, directory) {
  if (process.platform !== 'win32') return;
  const { secureWindowsAuthAcl } = await import('./mcp-auth-profile.mjs');
  await secureWindowsAuthAcl(target, { directory, apply: true });
}

/** Every directory from the workspace registry's folder down is real and, on POSIX, private. */
async function machineDirectory(segments, { create = false } = {}) {
  const base = workspaceFilesBase();
  const anchor = path.dirname(path.dirname(base));
  if (create) await mkdir(anchor, { recursive: true, mode: 0o700 });
  let cursor = anchor;
  for (const segment of ['environment-files', 'v1', ...segments]) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
      fail('A workspace-level environment-file location is invalid.', 'ENV_FILES_STORE_UNSAFE');
    }
    cursor = path.join(cursor, segment);
    let info = await lstat(cursor).catch(notFound);
    if (!info && create) {
      await mkdir(cursor, { mode: 0o700 }).catch((error) => (error?.code === 'EEXIST' ? null : Promise.reject(error)));
      await windowsPrivate(cursor, true);
      info = await lstat(cursor);
    }
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isDirectory()) fail(`'${cursor}' must be a real directory.`, 'ENV_FILES_STORE_UNSAFE');
    if (process.platform !== 'win32' && (info.mode & 0o077)) fail(`'${cursor}' grants group or other access.`, 'ENV_FILES_STORE_UNSAFE');
  }
  return cursor;
}

async function writeMachineFile(segments, name, bytes) {
  const directory = await machineDirectory(segments, { create: true });
  const temporary = path.join(directory, `.pending-${process.pid}-${randomUUID()}`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await windowsPrivate(temporary, false);
    await rename(temporary, path.join(directory, name));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return path.join(directory, name);
}

async function readMachineFile(segments, name, maximumBytes = MAXIMUM_RECORD_BYTES) {
  const directory = await machineDirectory(segments);
  if (!directory) return null;
  const target = path.join(directory, name);
  const info = await lstat(target).catch(notFound);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.size > maximumBytes) fail(`'${target}' is not a bounded regular file.`, 'ENV_FILES_STORE_UNSAFE');
  if (process.platform !== 'win32' && (info.mode & 0o077)) fail(`'${target}' grants group or other access.`, 'ENV_FILES_STORE_UNSAFE');
  return readFile(target);
}

// ---------------------------------------------------------------------------------------------
// Registry: paths and metadata only.

function invalidRegistry(where) {
  return new SingularityFlowError(`The environment-file registry at ${where} is invalid. Repair or remove it; it never holds file contents.`,
    { code: 'ENVIRONMENT_FILES_REGISTRY_INVALID', details: { registry: where } });
}

function parseRegistry(bytes, where) {
  let record;
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalidRegistry(where); }
  const keys = record && typeof record === 'object' && !Array.isArray(record) ? Object.keys(record).sort().join() : '';
  if (keys !== 'entries,kind,schemaVersion' || supportedRecordVersions[record.schemaVersion] !== true || record.kind !== 'environment-files-registry'
      || !Array.isArray(record.entries) || record.entries.length > MAXIMUM_ENTRIES) throw invalidRegistry(where);
  const seen = new Set();
  for (const entry of record.entries) {
    const valid = entry && typeof entry === 'object' && Object.keys(entry).sort().join() === [...ENTRY_KEYS].sort().join()
      && typeof entry.environment === 'string' && ENVIRONMENT_IDENTIFIER.test(entry.environment) && isExactEnvironmentFilePath(entry.path)
      && ORIGINS.includes(entry.origin) && SOURCES.includes(entry.source)
      && (entry.linkedPath === null || (typeof entry.linkedPath === 'string' && path.isAbsolute(entry.linkedPath)
        && entry.linkedPath.length <= 4_096 && !entry.linkedPath.includes('\0')))
      && (entry.source === 'linked') === (entry.linkedPath !== null)
      && !Number.isNaN(Date.parse(entry.createdAt)) && !Number.isNaN(Date.parse(entry.changedAt));
    const key = `${entry?.environment}\0${entry?.path}`;
    if (!valid || seen.has(key)) throw invalidRegistry(where);
    seen.add(key);
  }
  return record.entries.map((entry) => ({ ...entry }));
}

function registryBytes(entries) {
  const sorted = [...entries].sort((left, right) => left.environment.localeCompare(right.environment) || left.path.localeCompare(right.path));
  return `${JSON.stringify({ schemaVersion: 1, kind: 'environment-files-registry', entries: sorted.map((entry) => Object.fromEntries(ENTRY_KEYS.map((key) => [key, entry[key] ?? null]))) }, null, 2)}\n`;
}

function upsert(entries, environment, relative, patch) {
  const now = isoNow();
  const index = entries.findIndex((entry) => entry.environment === environment && entry.path === relative);
  if (index < 0) {
    entries.push({ environment, path: relative, origin: 'declared', source: 'store', linkedPath: null, createdAt: now, changedAt: now, ...patch });
  } else entries[index] = { ...entries[index], ...patch, changedAt: now };
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Scopes: one repository (any checkout of it), or a workspace's own level.

function safeWorkspaceId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) fail('The workspace ID cannot name a private folder.', 'ENV_FILES_STORE_UNSAFE');
  return id;
}

async function readRoots() {
  const bytes = await readMachineFile([], 'roots.json');
  if (!bytes) return {};
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { record = null; }
  if (record?.kind !== 'environment-files-roots' || supportedRecordVersions[record.schemaVersion] !== true || !record.workspaces || typeof record.workspaces !== 'object') {
    fail(`The environment-file folder settings in ${workspaceFilesBase()} are invalid. Repair or remove roots.json.`, 'ENVIRONMENT_FILES_REGISTRY_INVALID');
  }
  return record.workspaces;
}

/** The active workspace this checkout belongs to, and its repository ID, or nulls. */
async function membership(root) {
  try {
    const { sourceForRepository } = await import('./capability-context.mjs');
    const source = await sourceForRepository(root);
    const workspace = source?.workspace ?? null;
    return { repositoryId: source?.repositoryId ?? null, workspace, mapRoot: source?.mapRoot ?? root };
  } catch {
    return { repositoryId: null, workspace: null, mapRoot: root };
  }
}

function workspaceSummary(workspace) {
  return workspace ? { id: workspace.id, path: workspace.path } : null;
}

async function repositoryScope(root, { checkout = root, member = undefined, lookupWorkspace = true } = {}) {
  const found = member ?? (lookupWorkspace ? await membership(root) : { repositoryId: null, workspace: null, mapRoot: root });
  const workspace = found.workspace ?? null;
  const roots = workspace && await workspaceFilesStateExists() ? (await readRoots())[workspace.id] ?? {} : {};
  const store = environmentFilesStore(root);
  return {
    kind: 'repository', root, checkout, repositoryId: found.repositoryId ?? null, workspace, mapRoot: found.mapRoot ?? root, roots, store,
    label: found.repositoryId ? `repository '${found.repositoryId}'` : 'this repository',
    storeLocation: (environment, relative) => path.join(store, environment, ...relative.split('/')),
    rootLocation: (environment, relative) => (roots[environment] && found.repositoryId
      ? path.join(roots[environment], found.repositoryId, ...relative.split('/')) : null),
    async readRegistry() {
      const where = path.join(store, 'registry.json');
      const bytes = await readPrivateSidecar(root, where, { maximumBytes: MAXIMUM_RECORD_BYTES, optional: true, enforceWindowsAcl: true });
      return bytes ? parseRegistry(bytes, where) : [];
    },
    async writeRegistry(entries) {
      await writeMutablePrivateSidecar(root, path.join(store, 'registry.json'), registryBytes(entries), {
        maximumBytes: MAXIMUM_RECORD_BYTES, enforceWindowsAcl: true });
    },
    async writeStore(location, bytes) {
      await writeMutablePrivateSidecar(root, location, bytes, { maximumBytes: MAXIMUM_TEMPLATE_BYTES, enforceWindowsAcl: true });
    },
    async storeDirectory(location) {
      return safePrivateSidecarDirectory(root, path.dirname(location), { create: true, enforceWindowsAcl: true });
    },
    async placementsKey() {
      return createHash('sha256').update(await realpath(checkout)).digest('hex').slice(0, 32);
    },
    async readPlacements() {
      const bytes = await readPrivateSidecar(root, path.join(gitCommonDir(root), 'singularity-flow', 'environment-files', 'placements-v1', `${await this.placementsKey()}.json`),
        { maximumBytes: MAXIMUM_RECORD_BYTES, optional: true, enforceWindowsAcl: true }).catch(() => null);
      return placementsFrom(bytes);
    },
    async writePlacements(entries) {
      await writeMutablePrivateSidecar(root, path.join(gitCommonDir(root), 'singularity-flow', 'environment-files', 'placements-v1', `${await this.placementsKey()}.json`),
        placementBytes(entries), { maximumBytes: MAXIMUM_RECORD_BYTES, enforceWindowsAcl: true });
    }
  };
}

function workspaceScope(workspace, roots = {}) {
  const id = safeWorkspaceId(workspace.id);
  const segments = ['workspaces', id];
  const store = path.join(workspaceFilesBase(), ...segments);
  return {
    kind: 'workspace', root: null, checkout: workspace.path, repositoryId: null, workspace, roots, store,
    label: `workspace '${workspace.id}'`,
    storeLocation: (environment, relative) => path.join(store, environment, ...relative.split('/')),
    rootLocation: (environment, relative) => (roots[environment] ? path.join(roots[environment], WORKSPACE_FOLDER, ...relative.split('/')) : null),
    async readRegistry() {
      const bytes = await readMachineFile(segments, 'registry.json');
      return bytes ? parseRegistry(bytes, path.join(store, 'registry.json')) : [];
    },
    async writeRegistry(entries) { await writeMachineFile(segments, 'registry.json', registryBytes(entries)); },
    async writeStore(location, bytes) {
      const relative = path.relative(store, location).split(path.sep);
      await writeMachineFile([...segments, ...relative.slice(0, -1)], relative.at(-1), bytes);
    },
    async storeDirectory(location) {
      return machineDirectory([...segments, ...path.relative(store, path.dirname(location)).split(path.sep).filter(Boolean)], { create: true });
    },
    async readPlacements() { return placementsFrom(await readMachineFile(segments, 'placements.json').catch(() => null)); },
    async writePlacements(entries) { await writeMachineFile(segments, 'placements.json', placementBytes(entries)); }
  };
}

function placementsFrom(bytes) {
  if (!bytes) return new Map();
  try {
    const record = JSON.parse(bytes.toString('utf8'));
    if (record?.kind !== 'environment-files-placements' || !Array.isArray(record.entries)) return new Map();
    return new Map(record.entries.filter((entry) => isExactEnvironmentFilePath(entry?.path)).map((entry) => [entry.path, entry]));
  } catch { return new Map(); }
}

function placementBytes(entries) {
  return `${JSON.stringify({ schemaVersion: 1, kind: 'environment-files-placements', entries: [...entries.values()].sort((left, right) => left.path.localeCompare(right.path)) }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------
// Templates, resolution and the state of a path in a checkout.

/** Template names of a path, in the order the first existing one wins. */
export function templateCandidates(relative) {
  const directory = path.posix.dirname(relative);
  const base = path.posix.basename(relative);
  const extension = path.posix.extname(base);
  const names = TEMPLATE_MARKERS.flatMap((marker) => [
    ...(extension ? [`${base.slice(0, -extension.length)}.${marker}${extension}`] : []), `${base}.${marker}`
  ]);
  return names.map((name) => (directory === '.' ? name : `${directory}/${name}`));
}

/** The committed template beside a path, a regular file, or null. */
export async function templateFor(checkout, relative) {
  for (const candidate of templateCandidates(relative)) {
    const info = await lstat(path.join(checkout, ...candidate.split('/'))).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  return null;
}

async function regularFile(location, { follow = false } = {}) {
  const info = await (follow ? stat(location) : lstat(location)).catch(() => null);
  return Boolean(info?.isFile());
}

/** Where a file's real file is: linked (authoritative), else the workspace folder or store that has it. */
async function resolveFile(scope, file) {
  if (file.entry?.source === 'linked' && file.entry.linkedPath) {
    return { source: 'linked', location: file.entry.linkedPath, exists: await regularFile(file.entry.linkedPath, { follow: true }) };
  }
  const rootLocation = scope.rootLocation(file.environment, file.path);
  const storeLocation = scope.storeLocation(file.environment, file.path);
  if (rootLocation && await regularFile(rootLocation, { follow: true })) return { source: 'root', location: rootLocation, exists: true };
  if (await regularFile(storeLocation)) return { source: 'store', location: storeLocation, exists: true };
  return rootLocation ? { source: 'root', location: rootLocation, exists: false } : { source: 'store', location: storeLocation, exists: false };
}

function sameIdentity(recorded, info) {
  return Boolean(recorded) && recorded.dev === info.dev && recorded.ino === info.ino && recorded.size === info.size
    && recorded.mtimeMs === info.mtimeMs;
}

/**
 * What is at a file's path in the scope's checkout: absent, placed by SFlow (for which environment),
 * or unmanaged (a regular file, a directory, or a link SFlow did not make), never overwritten.
 */
async function pathState(scope, relative, placements, managed) {
  const located = await secureRepositoryPath(scope.checkout, relative, { label: `Environment file '${relative}'`, allowFinalSymlink: true });
  const target = located.absolute;
  const info = await lstat(target).catch(notFound);
  if (!info) return { kind: 'absent', target };
  const record = placements.get(relative) ?? null;
  if (info.isSymbolicLink()) {
    const link = path.resolve(path.dirname(target), await readlink(target));
    const environment = managed.get(link) ?? (record?.location === link ? record.environment : null)
      ?? (inside(scope.store, link) ? path.relative(scope.store, link).split(path.sep)[0] : null);
    return environment ? { kind: 'placed', mode: 'symlink', target, link, environment } : { kind: 'unmanaged', target, reason: 'a link' };
  }
  if (info.isFile() && record?.mode === 'copy' && sameIdentity(record.identity, info)) {
    return { kind: 'placed', mode: 'copy', target, environment: record.environment, location: record.location };
  }
  return { kind: 'unmanaged', target, reason: info.isFile() ? 'a regular file' : 'not a file' };
}

/** Every environment's files of a scope: declared exact localFiles and registry entries, by environment. */
function scopeFiles(declaration, entries, { workspaceLevel = false } = {}) {
  const files = [];
  const environments = new Set([...Object.keys(workspaceLevel ? {} : declaration?.environments ?? {}), ...entries.map((entry) => entry.environment)]);
  for (const environment of [...environments].sort()) {
    const declared = workspaceLevel ? [] : declaredEnvironmentFiles(declaration, environment);
    const byPath = new Map(declared.map((relative) => [relative, { environment, path: relative, origin: 'declared', declared: true, entry: null }]));
    for (const entry of entries.filter((candidate) => candidate.environment === environment)) {
      const known = byPath.get(entry.path);
      if (known) known.entry = entry;
      else byPath.set(entry.path, { environment, path: entry.path, origin: entry.origin, declared: false, entry });
    }
    files.push(...[...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)));
  }
  return files;
}

/** Whether a file belongs to a run: under the capability's sourceRoots, else under the working directory. */
export function inRunScope(relative, { sourceRoots = [], workingDirectory = null } = {}) {
  const norm = (value) => String(value ?? '').replaceAll('\\', '/').replace(/^(?:\.\/)+|\/+$/gu, '');
  const roots = (sourceRoots ?? []).map(norm);
  if (roots.length) return roots.some((root) => !root || root === '.' || relative === root || relative.startsWith(`${root}/`));
  const directory = norm(workingDirectory);
  return !directory || directory === '.' || relative.startsWith(`${directory}/`);
}

/** Files a run uses: the current declaration's and the person's own; a file no longer declared is not placed. */
function runFiles(files, environment, scopeOptions) {
  return files.filter((file) => file.environment === environment && (file.declared || file.origin === 'personal') && inRunScope(file.path, scopeOptions));
}

async function describe(scope, files) {
  const placements = await scope.readPlacements();
  const resolved = [];
  for (const file of files) resolved.push({ ...file, ...await resolveFile(scope, file) });
  const managed = new Map(resolved.map((file) => [file.location, file.environment]));
  for (const [relative, record] of placements) if (record?.location && !managed.has(record.location)) managed.set(record.location, record.environment);
  const states = new Map();
  for (const file of resolved) if (!states.has(file.path)) states.set(file.path, await pathState(scope, file.path, placements, managed));
  return { placements, resolved, states };
}

function fileStatus(file, state) {
  if (state.kind === 'placed' && state.environment === file.environment
      && (state.mode === 'copy' || state.link === file.location)) return 'placed-here';
  if (state.kind === 'unmanaged') return 'unmanaged';
  if (!file.exists) return 'missing';
  return file.source === 'linked' ? 'linked' : 'ready';
}

// ---------------------------------------------------------------------------------------------
// Local exclusion: the clone's common `.git/info/exclude`, shared by its worktrees.

function excludeLine(relative) {
  return `/${relative.replace(/ +$/u, (spaces) => spaces.replaceAll(' ', '\\ '))}`;
}

async function excludeFile(scope) {
  return path.join(gitCommonDir(scope.root), 'info', 'exclude');
}

/** Whether each path is excluded by SFlow's exact line. */
async function excludedPaths(scope, paths) {
  if (scope.kind !== 'repository') return new Set(paths);
  const text = await readFile(await excludeFile(scope), 'utf8').catch(() => '');
  const lines = new Set(text.split(/\r?\n/u));
  return new Set(paths.filter((relative) => lines.has(excludeLine(relative))));
}

/** Add each path once, under one comment naming SFlow; the team's .gitignore is never edited. */
export async function ensureExcluded(scope, paths) {
  if (scope.kind !== 'repository' || !paths.length) return [];
  const file = await excludeFile(scope);
  const directory = path.dirname(file);
  const directoryInfo = await lstat(directory).catch(notFound);
  if (directoryInfo && (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())) fail(`${directory} is not a real directory.`, 'ENV_FILES_EXCLUDE_UNSAFE');
  if (!directoryInfo) await mkdir(directory, { recursive: true });
  const info = await lstat(file).catch(notFound);
  if (info && (info.isSymbolicLink() || !info.isFile())) fail(`${file} is not a regular file; nothing was excluded.`, 'ENV_FILES_EXCLUDE_UNSAFE');
  const text = info ? await readFile(file, 'utf8') : '';
  const lines = new Set(text.split(/\r?\n/u));
  const missing = [...new Set(paths)].filter((relative) => !lines.has(excludeLine(relative)));
  if (!missing.length) return [];
  const addition = `${text && !text.endsWith('\n') ? '\n' : ''}${lines.has(EXCLUDE_COMMENT) ? '' : `${EXCLUDE_COMMENT}\n`}${missing.map(excludeLine).join('\n')}\n`;
  await appendFile(file, addition, { encoding: 'utf8', flag: fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0) });
  return missing;
}

// ---------------------------------------------------------------------------------------------
// Refusals.

function fixCommands(environment, file, suffix = '') {
  const target = `${shellWord(environment)} ${shellWord(file.path)}${suffix}`;
  return [
    `singularity-flow env files create ${target}${file.template ? ' --from-template' : ''}`,
    `singularity-flow env files link ${target} --to <FILE>`
  ];
}

function scopeSuffix(scope) {
  return scope.kind === 'workspace' ? ' --workspace' : '';
}

export function missingFilesRefusal(scope, environment, missing) {
  const suffix = scopeSuffix(scope);
  const listed = missing.map((file) => ({ path: file.path, template: file.template ?? null, commands: fixCommands(environment, file, suffix) }));
  const first = listed[0];
  return new SingularityFlowError(
    `Environment '${environment}' needs ${missing.length === 1 ? 'a file' : `${missing.length} files`} of ${scope.label} that ${missing.length === 1 ? 'is' : 'are'} missing on this machine: ${missing.map((file) => file.path).join(', ')}. `
      + `Create ${missing.length === 1 ? 'it' : 'each'} ${first.template ? `from its template (${first.commands[0]})` : `(${first.commands[0]})`}, or use a file you already have (${first.commands[1]}). Nothing ran.`,
    { code: 'ENV_FILE_MISSING', details: { environment, path: first.path, template: first.template, commands: first.commands, files: listed,
      recoveryCommands: [...first.commands, `singularity-flow env files ${shellWord(environment)}${suffix} --json`] } });
}

function trackedRefusal(scope, tracked) {
  return new SingularityFlowError(
    `${tracked.join(', ')} ${tracked.length === 1 ? 'is' : 'are'} tracked in Git, so ${tracked.length === 1 ? 'it' : 'they'} cannot be environment files of ${scope.label}. `
      + 'Remove the path from the repository (git rm --cached) and keep the values in an environment file, or remove it from localFiles through a configuration proposal. Nothing ran.',
    { code: 'ENV_FILE_TRACKED', details: { paths: tracked } });
}

// ---------------------------------------------------------------------------------------------
// Placement.

async function appRecordsUsing(scope, environment, paths) {
  if (scope.kind !== 'repository' || !paths.length) return [];
  const appRoot = path.join(gitCommonDir(scope.root), 'singularity-flow', 'app');
  const checkout = await realpath(scope.checkout);
  const conflicts = [];
  for (const capability of await listPrivateSidecar(scope.root, appRoot, { optional: true }).catch(() => [])) {
    if (!capability.isDirectory()) continue;
    for (const entry of await listPrivateSidecar(scope.root, path.join(appRoot, capability.name), { optional: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const bytes = await readPrivateSidecar(scope.root, path.join(appRoot, capability.name, entry.name), { maximumBytes: 16 * 1024, optional: true }).catch(() => null);
      let record = null;
      try { record = bytes ? JSON.parse(bytes.toString('utf8')) : null; } catch { record = null; }
      const used = record?.environmentFiles;
      if (record?.environment && record.environment !== environment && used?.checkout === checkout
          && Array.isArray(used.paths) && used.paths.some((relative) => paths.includes(relative))) conflicts.push(record);
    }
  }
  if (!conflicts.length) return [];
  const { recordedProcessAlive } = await import('./application-run.mjs');
  return conflicts.filter((record) => recordedProcessAlive(record));
}

async function placeOne(scope, file, state, platform) {
  if (state.kind === 'absent') {
    const parent = path.posix.dirname(file.path);
    if (parent !== '.') await ensureSecureRepositoryDirectory(scope.checkout, parent, { label: `Environment file '${file.path}' folder` });
  }
  const target = state.target;
  if (platform === 'win32') {
    if (state.kind === 'absent') await copyFile(file.location, target, fsConstants.COPYFILE_EXCL);
    else {
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.sflow-${randomUUID().slice(0, 8)}`);
      try { await copyFile(file.location, temporary, fsConstants.COPYFILE_EXCL); await rename(temporary, target); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    }
    const info = await lstat(target);
    return { mode: 'copy', identity: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs } };
  }
  if (state.kind === 'absent') await symlink(file.location, target);
  else {
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.sflow-${randomUUID().slice(0, 8)}`);
    try { await symlink(file.location, temporary); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return { mode: 'symlink', identity: null };
}

/**
 * Place one environment's files into the scope's checkout, or (check) only prove that they can be.
 * Refused before anything changes: a tracked path, a missing file, or switching a shared path while
 * an application started from SFlow in another environment still uses it. Returns paths only, and
 * the real files a run reads (placed or unmanaged) for its redactor.
 */
export async function placeEnvironmentFiles(scope, files, environment, { platform = process.platform, check = false } = {}) {
  if (!files.length) return { placed: [], unchanged: [], unmanaged: [], notes: [], reads: [], excluded: [] };
  const { placements, resolved, states } = await describe(scope, files);
  for (const file of resolved) file.template = await templateFor(scope.checkout, file.path);
  if (scope.kind === 'repository') {
    const tracked = trackedPaths(scope.checkout, resolved.map((file) => file.path));
    if (tracked.length) throw trackedRefusal(scope, tracked);
  }
  // A regular file or someone's own link at the path serves the run; a directory there does not.
  const missing = resolved.filter((file) => !file.exists && (states.get(file.path).kind !== 'unmanaged' || states.get(file.path).reason === 'not a file'));
  if (missing.length) throw missingFilesRefusal(scope, environment, missing);
  const switching = resolved.filter((file) => states.get(file.path).kind === 'placed' && states.get(file.path).environment !== environment);
  const busy = await appRecordsUsing(scope, environment, switching.map((file) => file.path));
  if (busy.length) {
    const record = busy[0];
    throw new SingularityFlowError(
      `${switching.map((file) => file.path).join(', ')} ${switching.length === 1 ? 'is' : 'are'} in use by start entry '${record.id}' of capability '${record.capability}', running in environment '${record.environment}' (pid ${record.pid}). `
        + `Stop it with singularity-flow app stop ${record.id} --capability ${record.capability}, then run in '${environment}' again. Nothing ran.`,
      { code: 'ENV_FILE_IN_USE', details: { environment, paths: switching.map((file) => file.path), runningEnvironment: record.environment,
        capability: record.capability, startId: record.id, pid: record.pid, recoveryCommand: `singularity-flow app stop ${record.id} --capability ${record.capability}` } });
  }
  if (check) return { placed: [], unchanged: [], unmanaged: [], notes: [], reads: [], excluded: [] };
  const excluded = await ensureExcluded(scope, resolved.map((file) => file.path));
  const result = { placed: [], unchanged: [], unmanaged: [], notes: [], reads: [], excluded };
  for (const file of resolved) {
    const state = states.get(file.path);
    if (state.kind === 'unmanaged') {
      result.unmanaged.push({ path: file.path, reason: state.reason });
      const adoptable = state.reason === 'a regular file';
      result.notes.push(state.reason === 'not a file' ? `${file.path} is not a file; it was left alone and nothing was placed there.`
        : `${file.path} is ${state.reason} SFlow did not place, so it was left alone and the run uses it.${adoptable ? ` Move it into the store and link it back with singularity-flow env files adopt ${shellWord(environment)} ${shellWord(file.path)}${scopeSuffix(scope)}.` : ''}`);
      // The run reads what is there; its values are blanked like a placed file's.
      if (state.reason !== 'not a file') result.reads.push({ path: file.path, location: state.target });
      continue;
    }
    if (file.source === 'store' && process.platform !== 'win32') {
      const info = await lstat(file.location);
      if (info.mode & 0o077) await chmod(file.location, 0o600);
    }
    result.reads.push({ path: file.path, location: file.location });
    if (state.kind === 'placed' && state.environment === environment && state.mode === 'symlink' && state.link === file.location && platform !== 'win32') {
      result.unchanged.push({ path: file.path, mode: 'symlink', source: file.source, location: file.location });
      continue;
    }
    const placed = await placeOne(scope, file, state, platform);
    placements.set(file.path, { path: file.path, environment, mode: placed.mode, location: file.location, identity: placed.identity, placedAt: isoNow() });
    result.placed.push({ path: file.path, mode: placed.mode, source: file.source, location: file.location, ...(state.kind === 'placed' && state.environment !== environment ? { switchedFrom: state.environment } : {}) });
    if (placed.mode === 'copy') {
      result.notes.push(`${file.path} is a copy of ${file.location}, refreshed at each run on Windows; edit the real file, never the copy.`);
    }
  }
  if (result.placed.length) await scope.writePlacements(placements);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Runs: app start, tests run and the publish and submit gates.

/**
 * Place environment `environment`'s files for one run in `checkout` and return the paths, the notes,
 * and (non-enumerable) the redaction entries of the values the run's files hold. Null when the run
 * has no environment file. `check` proves readiness only, before anything starts.
 */
export async function placeEnvironmentFilesForRun(root, environment, {
  declaration = undefined, checkout = root, sourceRoots = [], workingDirectory = null, platform = process.platform, check = false
} = {}) {
  const loaded = declaration === undefined ? await loadEnvironmentDeclaration(root, { optional: true }) : declaration;
  // The workspace is looked up only when this machine has workspace-level state at all.
  const lookupWorkspace = await workspaceFilesStateExists();
  const scope = await repositoryScope(root, { checkout, lookupWorkspace });
  const repositoryFiles = runFiles(scopeFiles(loaded, await scope.readRegistry()), environment, { sourceRoots, workingDirectory });
  let workspaceFiles = [];
  let workspace = null;
  if (scope.workspace) {
    workspace = workspaceScope(scope.workspace, scope.roots);
    workspaceFiles = runFiles(scopeFiles(null, await workspace.readRegistry(), { workspaceLevel: true }), environment, {});
  }
  if (!repositoryFiles.length && !workspaceFiles.length) return null;
  const repository = await placeEnvironmentFiles(scope, repositoryFiles, environment, { platform, check });
  const level = workspaceFiles.length ? await placeEnvironmentFiles(workspace, workspaceFiles, environment, { platform, check }) : null;
  const summary = {
    environment, checkout: await realpath(checkout),
    paths: [...repositoryFiles.map((file) => file.path)],
    placed: repository.placed.map((file) => file.path), unmanaged: repository.unmanaged.map((file) => file.path),
    ...(level ? { workspace: { id: scope.workspace.id, placed: level.placed.map((file) => file.path), unmanaged: level.unmanaged.map((file) => file.path) } } : {}),
    notes: [...repository.notes, ...(level?.notes ?? [])]
  };
  if (check) return summary;
  const { environmentFileRedactions } = await import('./environment-files-values.mjs');
  const { entries, unread } = await environmentFileRedactions([...repository.reads, ...(level?.reads ?? [])]);
  for (const relative of unread) summary.notes.push(`${relative} could not be read for redaction (too large, not UTF-8 or unreadable); its values are not blanked in output.`);
  Object.defineProperty(summary, 'redactions', { value: Object.freeze(entries), enumerable: false });
  return summary;
}

// ---------------------------------------------------------------------------------------------
// The `env files` reads and changes.

async function capabilityApps(scope) {
  try {
    const [{ readRetainedCapabilityMap }, { capabilityRepositories }] = await Promise.all([
      import('./capability-context.mjs'), import('./capabilities.mjs')]);
    const loaded = await readRetainedCapabilityMap(scope.mapRoot) ?? (scope.mapRoot !== scope.root ? await readRetainedCapabilityMap(scope.root) : null);
    return Object.entries(loaded?.definition?.capabilities ?? {})
      .filter(([, capability]) => capability.kind === 'delivery'
        && (!scope.repositoryId || capabilityRepositories(capability).includes(scope.repositoryId) || !capabilityRepositories(capability).length))
      .map(([id, capability]) => ({ id, sourceRoots: (capability.sourceRoots ?? []).map((entry) => String(entry).replace(/\/+$/u, '')).filter((entry) => entry && entry !== '.') }))
      .sort((left, right) => left.id.localeCompare(right.id));
  } catch { return []; }
}

function appFor(apps, relative) {
  let best = null;
  for (const app of apps) {
    for (const root of app.sourceRoots) {
      if ((relative === root || relative.startsWith(`${root}/`)) && (!best || root.length > best.root.length)) best = { app, root };
    }
  }
  return best?.app ?? null;
}

async function reportFiles(scope, files) {
  const { resolved, states } = await describe(scope, files);
  const excluded = await excludedPaths(scope, resolved.map((file) => file.path));
  const tracked = scope.kind === 'repository' && resolved.length ? new Set(trackedPaths(scope.checkout, [...new Set(resolved.map((file) => file.path))])) : new Set();
  const shown = [];
  for (const file of resolved) {
    const state = states.get(file.path);
    shown.push({
      environment: file.environment, path: file.path, kind: file.origin, template: await templateFor(scope.checkout, file.path),
      // Outside every repository there is nothing to exclude.
      source: file.source, location: file.location, status: fileStatus(file, state), excluded: scope.kind === 'repository' ? excluded.has(file.path) : null,
      placedFor: state.kind === 'placed' ? state.environment : null,
      placement: state.kind === 'placed' ? state.mode : null,
      problem: tracked.has(file.path) ? 'tracked' : file.origin === 'declared' && !file.declared ? 'no-longer-declared' : null
    });
  }
  return shown;
}

async function repositoryReport(scope, environment, { strict = false } = {}) {
  const declaration = await loadEnvironmentDeclaration(scope.checkout, { optional: true }).catch((error) => ({ error }));
  const entries = await scope.readRegistry();
  if (strict && environment && !declaration?.error && !Object.hasOwn(declaration?.environments ?? {}, environment)
      && !entries.some((entry) => entry.environment === environment)) {
    fail(`Environment '${environment}' is not declared in singularity/environments.yml of ${scope.label}. Declared: ${Object.keys(declaration?.environments ?? {}).sort().join(', ') || 'none'}.`,
      'ENVIRONMENT_UNKNOWN', { environment, recoveryCommand: 'singularity-flow env files --json' });
  }
  const files = scopeFiles(declaration?.error ? null : declaration, entries).filter((file) => !environment || file.environment === environment);
  const shown = await reportFiles(scope, files);
  const apps = await capabilityApps(scope);
  const groups = new Map();
  const listed = [];
  for (const file of shown) {
    const app = appFor(apps, file.path);
    listed.push(listedEntry(scope, app, file));
    const key = app?.id ?? '';
    if (!groups.has(key)) groups.set(key, { id: app?.id ?? null, kind: app ? 'capability' : 'repository', sourceRoots: app ? [...app.sourceRoots] : [], environments: new Map() });
    const group = groups.get(key);
    if (!group.environments.has(file.environment)) group.environments.set(file.environment, []);
    const { environment: _environment, ...rest } = file;
    group.environments.get(file.environment).push(rest);
  }
  const declared = declaration?.error ? 'invalid' : declaration ? 'ready' : 'missing';
  const environments = declaration?.error || !declaration ? [] : Object.keys(declaration.environments).sort();
  return {
    report: {
      id: scope.repositoryId, checkout: scope.checkout, store: scope.store,
      declaration: declared, environments,
      apps: [...groups.values()].sort((left, right) => (left.id ?? '').localeCompare(right.id ?? '')).map((group) => ({
        ...group, environments: [...group.environments].sort(([left], [right]) => left.localeCompare(right)).map(([name, list]) => ({ name, files: list }))
      }))
    },
    files: listed,
    environments: [...new Set([...environments, ...entries.map((entry) => entry.environment)])]
  };
}

function finishReport(result, environments, roots) {
  result.environments = [...new Set([...environments, ...result.files.map((file) => file.environment)])].sort();
  result.roots = { ...roots };
  return result;
}

async function memberCheckouts(scope) {
  const { workspaceRepositoryPath } = await import('./workspace-manifest.mjs');
  return Object.entries(scope.workspace.repositories ?? {}).sort(([left], [right]) => left.localeCompare(right))
    .map(([id, repository]) => ({ id, checkout: workspaceRepositoryPath(scope.workspace, repository) }));
}

/** The scope a command acts on: this checkout, a named member repository, or the workspace's own level. */
export async function commandScope(root, { repository = null, workspace = false } = {}) {
  const found = await membership(root);
  if (!repository && !workspace) return repositoryScope(root, { member: found });
  if (!found.workspace) {
    fail(`${workspace ? '--workspace' : '--repository'} needs the active workspace, and this checkout belongs to none. Select one with singularity-flow workspace use <WORKSPACE>.`,
      'ENV_FILES_WORKSPACE_REQUIRED');
  }
  if (workspace) return workspaceScope(found.workspace, (await workspaceFilesStateExists() ? (await readRoots())[found.workspace.id] : null) ?? {});
  const member = found.workspace.repositories?.[repository];
  if (!member) {
    fail(`Workspace '${found.workspace.id}' has no repository '${repository}'. Members: ${Object.keys(found.workspace.repositories ?? {}).sort().join(', ')}.`,
      'ENV_FILES_REPOSITORY_UNKNOWN', { repository, available: Object.keys(found.workspace.repositories ?? {}).sort() });
  }
  if (repository === found.repositoryId) return repositoryScope(root, { member: found });
  const { workspaceRepositoryPath } = await import('./workspace-manifest.mjs');
  const checkout = workspaceRepositoryPath(found.workspace, member);
  if (!repositoryGitDirectory(checkout)) fail(`Repository '${repository}' is not cloned at ${checkout}.`, 'ENV_FILES_REPOSITORY_MISSING', { repository, checkout });
  return repositoryScope(checkout, { member: { ...found, repositoryId: repository } });
}

/** `env files [ENV] [--repository ID | --workspace]`: every file with its status, never its contents. */
export async function environmentFilesReport(root, { environment = null, repository = null, workspace = false } = {}) {
  if (environment) environmentArgument(environment);
  const result = { schemaVersion: 1, resultType: 'sflow-env-files', scope: workspace ? 'workspace' : 'repository', environment,
    environments: [], roots: {}, files: [], repositories: [], workspace: null };
  if (!workspace) {
    const scope = await commandScope(root, { repository });
    const shown = await repositoryReport(scope, environment, { strict: true });
    result.repositories.push(shown.report);
    result.files.push(...shown.files);
    result.workspace = workspaceSummary(scope.workspace);
    return finishReport(result, shown.environments, scope.roots);
  }
  const level = await commandScope(root, { workspace: true });
  const environments = [];
  for (const member of await memberCheckouts(level)) {
    if (!repositoryGitDirectory(member.checkout)) {
      result.repositories.push({ id: member.id, checkout: member.checkout, store: null, declaration: 'not-cloned', environments: [], apps: [] });
      continue;
    }
    const scope = await repositoryScope(member.checkout, { member: { repositoryId: member.id, workspace: level.workspace, mapRoot: member.checkout } });
    const shown = await repositoryReport(scope, environment);
    result.repositories.push(shown.report);
    result.files.push(...shown.files);
    environments.push(...shown.environments);
  }
  const files = scopeFiles(null, await level.readRegistry(), { workspaceLevel: true }).filter((file) => !environment || file.environment === environment);
  const levelFiles = (await reportFiles(level, files)).map((file) => listedEntry(level, null, file));
  result.files.push(...levelFiles);
  result.workspace = { ...workspaceSummary(level.workspace), store: level.store, roots: { ...level.roots },
    files: levelFiles.map(({ repository: _repository, app: _app, ...file }) => file) };
  return finishReport(result, environments, level.roots);
}

async function knownFile(scope, environment, relative, { declaration = undefined } = {}) {
  const loaded = scope.kind === 'workspace' ? null
    : declaration === undefined ? await loadEnvironmentDeclaration(scope.checkout, { optional: true }) : declaration;
  const entries = await scope.readRegistry();
  const file = scopeFiles(loaded, entries, { workspaceLevel: scope.kind === 'workspace' })
    .find((candidate) => candidate.environment === environment && candidate.path === relative && (candidate.declared || candidate.origin === 'personal'));
  return { file, entries, declaration: loaded };
}

function undeclared(scope, environment, relative) {
  return new SingularityFlowError(
    `${relative} is not an environment file of '${environment}' in ${scope.label}. Declare it for the team in localFiles (singularity-flow env files suggest drafts it), or add it for yourself with singularity-flow env files add ${shellWord(environment)} ${shellWord(relative)} --personal${scopeSuffix(scope)}.`,
    { code: 'ENV_FILE_UNDECLARED', details: { environment, path: relative, recoveryCommands: [
      `singularity-flow env files add ${shellWord(environment)} ${shellWord(relative)} --personal${scopeSuffix(scope)}`, 'singularity-flow env files suggest'] } });
}

/** `env files path`: the resolved real location, for an editor to open. A path only. */
export async function environmentFilePath(scope, environment, relative) {
  const { file } = await knownFile(scope, environment, relative);
  if (!file) throw undeclared(scope, environment, relative);
  const { resolved, states } = await describe(scope, [file]);
  const [shown] = resolved;
  return {
    schemaVersion: 1, resultType: 'sflow-env-file-path', scope: scope.kind, repository: scope.repositoryId, workspace: workspaceSummary(scope.workspace),
    environment, path: relative, kind: file.origin, source: shown.source, location: shown.location, exists: shown.exists,
    status: fileStatus(shown, states.get(relative))
  };
}

async function placeSingle(scope, file, environment, platform) {
  try {
    return await placeEnvironmentFiles(scope, [file], environment, { platform });
  } catch (error) {
    if (error?.code === 'ENV_FILE_IN_USE') return { placed: [], unchanged: [], unmanaged: [], notes: [error.message], reads: [], excluded: [] };
    throw error;
  }
}

/** One file as the flat `files[]` of env files lists it. */
function listedEntry(scope, app, file) {
  return { repository: scope.kind === 'repository' ? scope.repositoryId : null, app: app?.id ?? null, ...file,
    ...(scope.kind === 'workspace' ? { problem: null } : {}) };
}

async function entryFor(scope, environment, relative) {
  const { file } = await knownFile(scope, environment, relative);
  if (!file) return null;
  const [shown] = await reportFiles(scope, [file]);
  return listedEntry(scope, scope.kind === 'repository' ? appFor(await capabilityApps(scope), relative) : null, shown);
}

async function changeResult(resultType, scope, environment, relative, extra, placement) {
  return {
    schemaVersion: 1, resultType, scope: scope.kind, repository: scope.repositoryId, workspace: workspaceSummary(scope.workspace),
    environment, path: relative, ...extra,
    placement: placement ? { placed: placement.placed.map((file) => file.path), unchanged: placement.unchanged.map((file) => file.path),
      unmanaged: placement.unmanaged.map((file) => file.path), excluded: placement.excluded ?? [], notes: placement.notes } : null,
    entry: await entryFor(scope, environment, relative)
  };
}

async function boundedTemplate(location) {
  let handle;
  try {
    handle = await open(location, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAXIMUM_TEMPLATE_BYTES) fail(`The template is not a regular file of at most ${MAXIMUM_TEMPLATE_BYTES} bytes.`, 'ENV_FILE_TEMPLATE_INVALID');
    return await handle.readFile();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeUserFile(location, bytes) {
  await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  const handle = await open(location, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await windowsPrivate(location, false);
}

/** `env files create`: the real file from its template (or empty), private, placed here, its location printed. */
export async function createEnvironmentFile(scope, environment, relative, { fromTemplate = false, platform = process.platform } = {}) {
  const { file, entries } = await knownFile(scope, environment, relative);
  if (!file) throw undeclared(scope, environment, relative);
  const resolved = await resolveFile(scope, file);
  if (resolved.source === 'linked') {
    fail(`${relative} uses the linked file ${resolved.location}${resolved.exists ? '' : ', which is missing'}. Edit that file, link another with env files link --to, or stop using it with singularity-flow env files unlink ${shellWord(environment)} ${shellWord(relative)}${scopeSuffix(scope)}.`,
      'ENV_FILE_LINKED', { environment, path: relative, location: resolved.location });
  }
  if (resolved.exists) {
    fail(`${relative} already exists for '${environment}' at ${resolved.location}; nothing was overwritten. Open it with singularity-flow env files path ${shellWord(environment)} ${shellWord(relative)}${scopeSuffix(scope)}.`,
      'ENV_FILE_EXISTS', { environment, path: relative, location: resolved.location,
        recoveryCommand: `singularity-flow env files path ${shellWord(environment)} ${shellWord(relative)}${scopeSuffix(scope)}` });
  }
  const template = await templateFor(scope.checkout, relative);
  if (fromTemplate && !template) {
    fail(`${relative} has no template beside it. Looked for: ${templateCandidates(relative).join(', ')}. Create it empty without --from-template.`,
      'ENV_FILE_TEMPLATE_MISSING', { environment, path: relative, candidates: templateCandidates(relative) });
  }
  const bytes = fromTemplate ? await boundedTemplate(path.join(scope.checkout, ...template.split('/'))) : Buffer.alloc(0);
  if (resolved.source === 'root') await writeUserFile(resolved.location, bytes);
  else await scope.writeStore(resolved.location, bytes);
  upsert(entries, environment, relative, { origin: file.origin, source: resolved.source, linkedPath: null });
  await scope.writeRegistry(entries);
  const placement = await placeSingle(scope, file, environment, platform);
  return changeResult('sflow-env-file-created', scope, environment, relative, {
    kind: file.origin, source: resolved.source, location: resolved.location, fromTemplate: fromTemplate ? template : null
  }, placement);
}

async function enclosingCheckout(directory) {
  let cursor = directory;
  for (;;) {
    if (repositoryGitDirectory(cursor)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** A file a person points a path at: a readable regular file, not tracked anywhere, not in this repository's checkouts. */
async function linkTarget(scope, to) {
  const requested = path.resolve(String(to));
  let real;
  try { real = await realpath(requested); } catch (error) {
    if (error?.code === 'ELOOP') fail(`${requested} is a symbolic link loop.`, 'ENV_FILE_LINK_INVALID', { to: requested, reason: 'symlink-loop' });
    fail(`${requested} does not exist.`, 'ENV_FILE_LINK_INVALID', { to: requested, reason: 'missing' });
  }
  const info = await stat(real);
  if (!info.isFile()) fail(`${requested} is ${info.isDirectory() ? 'a directory' : 'not a regular file'}; link a regular file.`, 'ENV_FILE_LINK_INVALID', { to: requested, reason: 'not-a-file' });
  try { await (await open(real, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0))).close(); }
  catch { fail(`${requested} cannot be read by you.`, 'ENV_FILE_LINK_INVALID', { to: requested, reason: 'unreadable' }); }
  if (inside(await realpath(scope.store).catch(() => scope.store), real)) {
    fail(`${requested} is in SFlow's private store; create the file there with env files create instead.`, 'ENV_FILE_LINK_INVALID', { to: requested, reason: 'in-store' });
  }
  const checkout = await enclosingCheckout(path.dirname(real));
  if (checkout) {
    const [enclosing, own] = await Promise.all([realpath(repositoryGitDirectory(checkout)).catch(() => null), realpath(gitCommonDir(scope.root)).catch(() => null)]);
    if (scope.kind === 'repository' && enclosing && enclosing === own) {
      fail(`${requested} is inside a checkout of this repository, where Git could pick it up. Keep it outside every checkout, or move it into the store with env files adopt.`,
        'ENV_FILE_LINK_INVALID', { to: requested, reason: 'inside-checkout' });
    }
    let tracked;
    try { tracked = trackedPaths(checkout, [path.relative(await realpath(checkout), real).split(path.sep).join('/')]); }
    catch { fail(`${requested} is inside a Git checkout that could not be checked, so it was not linked.`, 'ENV_FILE_LINK_INVALID', { to: requested, reason: 'unverifiable' }); }
    if (tracked.length) fail(`${requested} is tracked in the Git repository at ${checkout}; an environment file must never be in Git.`, 'ENV_FILE_LINK_INVALID', { to: requested, reason: 'tracked' });
  }
  if (scope.kind === 'workspace') {
    for (const member of await memberCheckouts(scope)) {
      if (inside(await realpath(member.checkout).catch(() => member.checkout), real)) {
        fail(`${requested} is inside repository '${member.id}', where Git could pick it up. Keep it outside every checkout.`, 'ENV_FILE_LINK_INVALID', { to: requested, reason: 'inside-checkout' });
      }
    }
  }
  return real;
}

/** `env files link --to FILE` (or `--clear`): use an existing file for a path, or stop using it. */
export async function linkEnvironmentFile(scope, environment, relative, { to = null, clear = false, platform = process.platform } = {}) {
  const { file, entries } = await knownFile(scope, environment, relative);
  if (!file) throw undeclared(scope, environment, relative);
  if (clear) {
    const previous = file.entry?.source === 'linked' ? file.entry.linkedPath : null;
    upsert(entries, environment, relative, { origin: file.origin, source: 'store', linkedPath: null });
    await scope.writeRegistry(entries);
    const cleared = { ...file, entry: entries.find((entry) => entry.environment === environment && entry.path === relative) };
    const { resolved, states } = await describe(scope, [cleared]);
    const state = states.get(relative);
    let placement = null;
    if (resolved[0].exists) placement = await placeSingle(scope, cleared, environment, platform);
    else if (state.kind === 'placed' && state.mode === 'symlink' && previous && state.link === previous) await unlink(state.target);
    return changeResult('sflow-env-file-unlinked', scope, environment, relative, { previous, source: resolved[0].source, location: resolved[0].location, exists: resolved[0].exists }, placement);
  }
  if (!to) fail('env files link needs --to <FILE>, or --clear to stop using a linked file.', 'ENV_FILES_INVALID');
  const real = await linkTarget(scope, to);
  upsert(entries, environment, relative, { origin: file.origin, source: 'linked', linkedPath: real });
  await scope.writeRegistry(entries);
  const linked = { ...file, entry: entries.find((entry) => entry.environment === environment && entry.path === relative) };
  const placement = await placeSingle(scope, linked, environment, platform);
  return changeResult('sflow-env-file-linked', scope, environment, relative, { kind: file.origin, source: 'linked', location: real }, placement);
}

/** `env files unlink`: stop using a linked file; it falls back to the workspace folder or the store, and is never deleted. */
export async function unlinkEnvironmentFile(scope, environment, relative, options = {}) {
  return linkEnvironmentFile(scope, environment, relative, { ...options, clear: true });
}

/** `env files adopt`: move an unmanaged file at the path into the store and link it back. */
export async function adoptEnvironmentFile(scope, environment, relative, { platform = process.platform } = {}) {
  const { file, entries } = await knownFile(scope, environment, relative);
  if (!file) throw undeclared(scope, environment, relative);
  if (file.entry?.source === 'linked') {
    fail(`${relative} uses the linked file ${file.entry.linkedPath}; stop using it first with singularity-flow env files unlink ${shellWord(environment)} ${shellWord(relative)}${scopeSuffix(scope)}.`,
      'ENV_FILE_LINKED', { environment, path: relative, location: file.entry.linkedPath });
  }
  const { states } = await describe(scope, [file]);
  const state = states.get(relative);
  const info = state.kind === 'unmanaged' ? await lstat(state.target) : null;
  if (!info?.isFile() || info.isSymbolicLink()) {
    fail(`${relative} has no unmanaged regular file to adopt here (${state.kind === 'absent' ? 'nothing is at the path' : state.kind === 'placed' ? 'SFlow already placed it' : state.reason}).`,
      'ENV_FILE_NOT_UNMANAGED', { environment, path: relative, state: state.kind });
  }
  if (scope.kind === 'repository' && trackedPaths(scope.checkout, [relative]).length) throw trackedRefusal(scope, [relative]);
  const destination = scope.storeLocation(environment, relative);
  if (await lstat(destination).catch(() => null)) {
    fail(`The store already has ${relative} for '${environment}' at ${destination}; the file here was left alone. Compare them, then remove one.`,
      'ENV_FILE_EXISTS', { environment, path: relative, location: destination });
  }
  await scope.storeDirectory(destination);
  try { await rename(state.target, destination); } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await copyFile(state.target, destination, fsConstants.COPYFILE_EXCL);
    await unlink(state.target);
  }
  if (process.platform === 'win32') await windowsPrivate(destination, false);
  else await chmod(destination, 0o600);
  upsert(entries, environment, relative, { origin: file.origin, source: 'store', linkedPath: null });
  await scope.writeRegistry(entries);
  const placement = await placeSingle(scope, { ...file, entry: entries.find((entry) => entry.environment === environment && entry.path === relative) }, environment, platform);
  return changeResult('sflow-env-file-adopted', scope, environment, relative, { kind: file.origin, source: 'store', location: destination }, placement);
}

/** `env files add --personal`: a file only this person uses, protected exactly like a declared one. */
export async function addPersonalEnvironmentFile(scope, environment, relative) {
  const declaration = scope.kind === 'workspace' ? null : await loadEnvironmentDeclaration(scope.checkout, { optional: true });
  if (scope.kind === 'repository' && !Object.hasOwn(declaration?.environments ?? {}, environment)) {
    fail(`Environment '${environment}' is not declared in singularity/environments.yml of ${scope.label}. Declared: ${Object.keys(declaration?.environments ?? {}).sort().join(', ') || 'none'}.`,
      'ENVIRONMENT_UNKNOWN', { environment });
  }
  if (declaredEnvironmentFiles(declaration, environment).includes(relative)) {
    fail(`${relative} is already declared for '${environment}' for the whole team; create or link it instead.`, 'ENV_FILE_ALREADY_DECLARED', { environment, path: relative });
  }
  if (scope.kind === 'repository' && trackedPaths(scope.checkout, [relative]).length) throw trackedRefusal(scope, [relative]);
  if (scope.kind === 'workspace') {
    const absolute = path.join(scope.checkout, ...relative.split('/'));
    for (const member of await memberCheckouts(scope)) {
      if (inside(member.checkout, absolute)) fail(`${relative} is inside repository '${member.id}'; add it there with --repository ${member.id}.`, 'ENV_FILE_IN_REPOSITORY', { repository: member.id });
    }
  }
  const entries = await scope.readRegistry();
  const existing = entries.find((entry) => entry.environment === environment && entry.path === relative);
  if (!existing) {
    upsert(entries, environment, relative, { origin: 'personal', source: 'store', linkedPath: null });
    await scope.writeRegistry(entries);
  }
  const excluded = await ensureExcluded(scope, [relative]);
  const file = { environment, path: relative, origin: 'personal', declared: false, entry: existing ?? entries.find((entry) => entry.environment === environment && entry.path === relative) };
  const resolved = await resolveFile(scope, file);
  return changeResult('sflow-env-file-added', scope, environment, relative, {
    kind: 'personal', added: !existing, source: resolved.source, location: resolved.location, exists: resolved.exists,
    next: resolved.exists ? [] : fixCommands(environment, { path: relative, template: await templateFor(scope.checkout, relative) }, scopeSuffix(scope))
  }, { placed: [], unchanged: [], unmanaged: [], excluded, notes: [] });
}

/** `env files remove --personal`: forget a personal file; its real file is kept, and SFlow's link here is removed. */
export async function removePersonalEnvironmentFile(scope, environment, relative) {
  const entries = await scope.readRegistry();
  const entry = entries.find((candidate) => candidate.environment === environment && candidate.path === relative);
  if (!entry || entry.origin !== 'personal') {
    fail(`${relative} is not a personal environment file of '${environment}' in ${scope.label}.`, 'ENV_FILE_NOT_PERSONAL', { environment, path: relative });
  }
  const file = { environment, path: relative, origin: 'personal', declared: false, entry };
  const { resolved, states } = await describe(scope, [file]);
  const state = states.get(relative);
  let removedLink = false;
  if (state.kind === 'placed' && state.environment === environment) { await unlink(state.target); removedLink = true; }
  await scope.writeRegistry(entries.filter((candidate) => candidate !== entry));
  return changeResult('sflow-env-file-removed', scope, environment, relative, {
    removed: true, removedLink, kept: resolved[0].exists ? resolved[0].location : null
  }, null);
}

/** `env files root ENV DIR | --clear`: the workspace's folder for one environment, for every repository. */
export async function setEnvironmentRoot(root, environment, directory, { clear = false } = {}) {
  const found = await membership(root);
  if (!found.workspace) {
    fail('env files root sets a folder for the active workspace, and this checkout belongs to none. Select one with singularity-flow workspace use <WORKSPACE>.', 'ENV_FILES_WORKSPACE_REQUIRED');
  }
  const id = safeWorkspaceId(found.workspace.id);
  const all = await workspaceFilesStateExists() ? await readRoots() : {};
  const current = { ...(all[id] ?? {}) };
  let folder = null;
  if (clear) delete current[environment];
  else {
    if (!directory) fail('env files root needs a folder, or --clear.', 'ENV_FILES_INVALID');
    try { folder = await realpath(path.resolve(String(directory))); } catch { fail(`${path.resolve(String(directory))} does not exist.`, 'ENV_FILES_ROOT_INVALID'); }
    if (!(await stat(folder)).isDirectory()) fail(`${folder} is not a folder.`, 'ENV_FILES_ROOT_INVALID');
    const level = workspaceScope(found.workspace);
    for (const member of await memberCheckouts(level)) {
      const checkout = await realpath(member.checkout).catch(() => member.checkout);
      if (inside(checkout, folder)) fail(`${folder} is inside repository '${member.id}', where Git could pick its files up. Choose a folder outside every checkout.`, 'ENV_FILES_ROOT_INVALID', { repository: member.id });
    }
    current[environment] = folder;
  }
  const next = { ...all };
  if (Object.keys(current).length) next[id] = current;
  else delete next[id];
  const written = await writeMachineFile([], 'roots.json', `${JSON.stringify({ schemaVersion: 1, kind: 'environment-files-roots', workspaces: next }, null, 2)}\n`);
  return {
    schemaVersion: 1, resultType: 'sflow-env-files-root', workspace: workspaceSummary(found.workspace), environment,
    root: clear ? null : folder, cleared: clear, settings: written,
    layout: clear ? null : { repository: path.join(folder, '<repository-id>', '<path>'), workspace: path.join(folder, WORKSPACE_FOLDER, '<path>') }
  };
}

/** `env files place ENV`: place now what a run would place (runs do it themselves). */
export async function placeForCommand(root, environment, { capability = null, workspace = false, platform = process.platform } = {}) {
  const result = { schemaVersion: 1, resultType: 'sflow-env-files-placed', environment, capability, repositories: [], workspace: null };
  const placeIn = async (scope, sourceRoots) => {
    const declaration = await loadEnvironmentDeclaration(scope.checkout, { optional: true });
    const files = runFiles(scopeFiles(declaration, await scope.readRegistry()), environment, { sourceRoots });
    const placed = await placeEnvironmentFiles(scope, files, environment, { platform });
    return { id: scope.repositoryId, checkout: scope.checkout, files: files.map((file) => file.path), placed: placed.placed.map((file) => file.path),
      unchanged: placed.unchanged.map((file) => file.path), unmanaged: placed.unmanaged.map((file) => file.path), excluded: placed.excluded, notes: placed.notes };
  };
  if (!workspace) {
    const scope = await commandScope(root);
    let sourceRoots = [];
    if (capability) {
      const { resolveCapabilityApplication } = await import('./capability-application-context.mjs');
      sourceRoots = (await resolveCapabilityApplication(root, { capabilityId: capability, readApplication: false })).capability?.sourceRoots ?? [];
    }
    result.repositories.push(await placeIn(scope, sourceRoots));
    return result;
  }
  const level = await commandScope(root, { workspace: true });
  for (const member of await memberCheckouts(level)) {
    if (!repositoryGitDirectory(member.checkout)) continue;
    result.repositories.push(await placeIn(await repositoryScope(member.checkout, { member: { repositoryId: member.id, workspace: level.workspace, mapRoot: member.checkout } }), []));
  }
  const files = runFiles(scopeFiles(null, await level.readRegistry(), { workspaceLevel: true }), environment, {});
  const placed = await placeEnvironmentFiles(level, files, environment, { platform });
  result.workspace = { ...workspaceSummary(level.workspace), files: files.map((file) => file.path), placed: placed.placed.map((file) => file.path),
    unchanged: placed.unchanged.map((file) => file.path), unmanaged: placed.unmanaged.map((file) => file.path), notes: placed.notes };
  return result;
}
