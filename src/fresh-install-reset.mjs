import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { copilotSkillsDirectory, uninstallDirectSkills } from './direct-skills.mjs';
import { machineStateRoot } from './factory-reset.mjs';
import { readWorkspace, readWorkspaceRegistry } from './workspace.mjs';
import { activeWorkspaceFile, workspaceRegistryFile } from './workspace-context.mjs';
import { run, SingularityFlowError } from './util.mjs';
import { localWorkJournalRoot } from './local-work-journal.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { withMachineStateResetBarrier } from './machine-state-reset.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';

export const FRESH_INSTALL_CONFIRMATION = 'RESET EVERYTHING';
export const LOCAL_RESET_CONFIRMATION = 'RESET LOCAL';
export const LOCAL_FORGET_CONFIRMATION = 'FORGET LOCAL';
export const VSCODE_RESET_MARKER = 'vscode-fresh-reset-pending.json';
const INSTALLER_GENERATED_ROOTS = ['singularity', '.singularity', '.github/agents'];
const RESET_TARGET_PROOFS = Symbol('singularity-flow.reset-target-proofs');

function resetGitEnvironment(environment = process.env) {
  const sanitized = withoutGitProcessOverrides({ ...process.env, ...environment });
  delete sanitized.GIT_CONFIG_GLOBAL;
  delete sanitized.GIT_CONFIG_SYSTEM;
  delete sanitized.GIT_ATTR_NOSYSTEM;
  return {
    ...sanitized,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false'
  };
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Normalize a filesystem identity reported by Git or Node without assuming that both use the
 * host's preferred separators or drive-letter casing. Git for Windows normally prints `C:/...`,
 * while `realpath()` returns `C:\\...`; UNC and extended-length UNC spellings have the same split.
 * Keep this helper pure so non-Windows CI can exercise the Windows comparison contract.
 */
export function resetPathIdentity(value, platform = process.platform) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (platform !== 'win32') return path.resolve(raw);

  let windows = raw.replaceAll('/', '\\');
  if (/^\\\\\?\\UNC\\/i.test(windows)) windows = `\\\\${windows.slice(8)}`;
  else if (/^\\\\\?\\/i.test(windows)) windows = windows.slice(4);
  // A few MSYS-facing Git builds report a drive root as /c/path even to a native Node parent.
  if (/^\\[a-z](?:\\|$)/i.test(windows)) windows = `${windows[1]}:${windows.slice(2)}`;
  const normalized = path.win32.normalize(windows);
  const root = path.win32.parse(normalized).root;
  const withoutTrailing = normalized.length > root.length
    ? normalized.replace(/[\\]+$/u, '')
    : normalized;
  return withoutTrailing.toLowerCase();
}

export function sameResetPathIdentity(left, right, platform = process.platform) {
  const leftIdentity = resetPathIdentity(left, platform);
  const rightIdentity = resetPathIdentity(right, platform);
  return Boolean(leftIdentity) && leftIdentity === rightIdentity;
}

function resetTargetKind(info) {
  if (info?.isDirectory()) return 'directory';
  if (info?.isFile()) return 'file';
  return 'other';
}

function resetTargetIdentity(info) {
  return {
    dev: Number.isFinite(info?.dev) ? info.dev : null,
    ino: Number.isFinite(info?.ino) ? info.ino : null,
    kind: resetTargetKind(info)
  };
}

function sameResetTargetIdentity(left, right) {
  if (left.kind !== right.kind) return false;
  // Node exposes stable device/inode identities on the supported desktop filesystems. Some
  // Windows providers return zero; canonical path and type remain the fail-closed fallback there.
  if (left.dev && left.ino && right.dev && right.ino) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return true;
}

async function resetTargetProof(target, { label, type = 'either' }) {
  const requestedPath = path.resolve(target);
  const direct = await lstat(requestedPath).catch((error) =>
    error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (direct?.isSymbolicLink()) {
    throw new SingularityFlowError(`${label} must not be a symbolic link: ${requestedPath}`);
  }
  if (direct) {
    if (type === 'directory' && !direct.isDirectory()) {
      throw new SingularityFlowError(`${label} must be a directory: ${requestedPath}`);
    }
    if (type === 'file' && !direct.isFile()) {
      throw new SingularityFlowError(`${label} must be a regular file: ${requestedPath}`);
    }
    if (type === 'either' && !direct.isDirectory() && !direct.isFile()) {
      throw new SingularityFlowError(`${label} must be a regular file or directory: ${requestedPath}`);
    }
    const canonicalPath = await realpath(requestedPath);
    const canonicalInfo = await lstat(canonicalPath);
    if (canonicalInfo.isSymbolicLink() || !sameResetTargetIdentity(
      resetTargetIdentity(direct), resetTargetIdentity(canonicalInfo)
    )) {
      throw new SingularityFlowError(`${label} changed while its canonical path was being resolved: ${requestedPath}`);
    }
    return Object.freeze({
      requestedPath,
      path: canonicalPath,
      exists: true,
      type,
      label,
      identity: resetTargetIdentity(canonicalInfo)
    });
  }

  const suffix = [];
  let cursor = requestedPath;
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new SingularityFlowError(`${label} has no existing filesystem anchor: ${requestedPath}`);
    }
    suffix.unshift(path.basename(cursor));
    cursor = parent;
    const anchorInfo = await lstat(cursor).catch((error) =>
      error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!anchorInfo) continue;
    if (!anchorInfo.isDirectory() && !anchorInfo.isSymbolicLink()) {
      throw new SingularityFlowError(`${label} has a non-directory parent: ${cursor}`);
    }
    const anchor = await realpath(cursor);
    const canonicalPath = path.resolve(anchor, ...suffix);
    const relative = path.relative(anchor, canonicalPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new SingularityFlowError(`${label} escapes its canonical parent: ${requestedPath}`);
    }
    const canonicalAnchorInfo = await lstat(anchor);
    return Object.freeze({
      requestedPath,
      path: canonicalPath,
      exists: false,
      type,
      label,
      anchor,
      anchorIdentity: resetTargetIdentity(canonicalAnchorInfo)
    });
  }
}

async function assertResetTargetProof(proof) {
  const current = await resetTargetProof(proof.requestedPath, {
    label: proof.label,
    type: proof.type
  });
  if (!sameResetPathIdentity(current.path, proof.path)
      || current.exists !== proof.exists
      || (proof.exists && !sameResetTargetIdentity(current.identity, proof.identity))
      || (!proof.exists && (!sameResetPathIdentity(current.anchor, proof.anchor)
        || !sameResetTargetIdentity(current.anchorIdentity, proof.anchorIdentity)))) {
    throw new SingularityFlowError(
      `${proof.label} changed after reset planning; refusing to touch either location: ${proof.requestedPath}`
    );
  }
  return current;
}

async function existingDirectory(target, label) {
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return null;
  if (info.isSymbolicLink()) throw new SingularityFlowError(`${label} must not be a symbolic link: ${target}`);
  if (!info.isDirectory()) throw new SingularityFlowError(`${label} must be a directory: ${target}`);
  return info;
}

async function validateResetTarget(target, { label, type = 'either' }) {
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return null;
  if (info.isSymbolicLink()) throw new SingularityFlowError(`${label} must not be a symbolic link: ${target}`);
  if (type === 'directory' && !info.isDirectory()) {
    throw new SingularityFlowError(`${label} must be a directory: ${target}`);
  }
  if (type === 'file' && !info.isFile()) {
    throw new SingularityFlowError(`${label} must be a regular file: ${target}`);
  }
  if (type === 'either' && !info.isDirectory() && !info.isFile()) {
    throw new SingularityFlowError(`${label} must be a regular file or directory: ${target}`);
  }
  return info;
}

function assertNarrowMachineTarget(target, { homeDirectory, projectDirectory, label }) {
  const resolved = path.resolve(target);
  const forbidden = [path.parse(resolved).root, path.resolve(homeDirectory), path.resolve(projectDirectory)];
  if (forbidden.includes(resolved) || inside(resolved, path.resolve(homeDirectory))
    || inside(resolved, path.resolve(projectDirectory))
    || inside(path.resolve(projectDirectory), resolved)) {
    throw new SingularityFlowError(`Refusing broad or protected ${label}: ${resolved}`);
  }
}

function machineStatePaths(environment, home, localStateRoot) {
  const registryFile = workspaceRegistryFile(environment, home);
  const selectionFile = activeWorkspaceFile(environment, home);
  const capabilityRegistryFile = path.resolve(environment.SINGULARITY_FLOW_LEAD_REGISTRY
    || path.join(localStateRoot, 'leads.json'));
  const capabilityCacheRoot = path.resolve(environment.SINGULARITY_FLOW_ORGANISATION_CACHE
    || (environment.SINGULARITY_FLOW_LEAD_REGISTRY
      ? path.join(path.dirname(environment.SINGULARITY_FLOW_LEAD_REGISTRY), 'organisation-cache')
      : path.join(localStateRoot, 'organisation-cache')));
  const vscodeResetMarker = path.resolve(environment.SINGULARITY_FLOW_VSCODE_RESET_MARKER
    || path.join(localStateRoot, VSCODE_RESET_MARKER));
  const journalRoot = localWorkJournalRoot(environment, home);
  return {
    registryFile,
    selectionFile,
    capabilityRegistryFile,
    capabilityCacheRoot,
    vscodeResetMarker,
    journalRoot
  };
}

async function canonicalResetBase(target, label) {
  const requested = path.resolve(target);
  const info = await lstat(requested).catch((error) =>
    error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isDirectory()) throw new SingularityFlowError(`${label} must be an existing directory: ${requested}`);
  return realpath(requested);
}

async function resolveMachineResetLocations({
  homeDirectory = os.homedir(),
  projectDirectory = process.cwd(),
  environment = process.env
} = {}) {
  const home = await canonicalResetBase(homeDirectory, 'Home directory');
  const project = await canonicalResetBase(projectDirectory, 'Current project directory');
  const localState = await resetTargetProof(machineStateRoot(home), {
    label: 'Singularity Flow machine state', type: 'directory'
  });
  const raw = machineStatePaths(environment, home, localState.path);
  const stateProofs = {};
  for (const [key, value] of Object.entries(raw)) {
    stateProofs[key] = await resetTargetProof(value, {
      label: ({
        registryFile: 'workspace registry',
        selectionFile: 'active-workspace selection',
        capabilityRegistryFile: 'capability lead registry',
        capabilityCacheRoot: 'custom capability cache',
        vscodeResetMarker: 'VS Code reset marker',
        journalRoot: 'custom local work journal'
      })[key] ?? key,
      type: key.endsWith('File') || key === 'vscodeResetMarker' ? 'file' : 'directory'
    });
  }
  return Object.freeze({ home, project, localState, stateProofs, environment });
}

function assertSameResetLocations(before, after) {
  const compared = [
    ['home directory', before.home, after.home],
    ['current project directory', before.project, after.project],
    ['machine-state root', before.localState.path, after.localState.path],
    ...Object.keys(before.stateProofs).map((key) => [
      before.stateProofs[key].label,
      before.stateProofs[key].path,
      after.stateProofs[key]?.path
    ])
  ];
  const changed = compared.find(([, left, right]) => !sameResetPathIdentity(left, right));
  if (changed) {
    throw new SingularityFlowError(
      `${changed[0]} changed through its filesystem path while the reset barrier was acquired; nothing was deleted.`
    );
  }
}

function deduplicateTargets(targets) {
  const byPath = new Map();
  for (const target of targets) {
    const resolved = path.resolve(target.path);
    const previous = byPath.get(resolved);
    byPath.set(resolved, previous?.type === 'directory' ? previous : { ...target, path: resolved });
  }
  const ordered = [...byPath.values()].sort((left, right) => left.path.length - right.path.length
    || left.path.localeCompare(right.path));
  return ordered.filter((candidate, index) => !ordered.slice(0, index).some((parent) =>
    parent.type === 'directory' && inside(parent.path, candidate.path)));
}

export function assertNarrowWorkspaceRoot(target, {
  homeDirectory,
  projectDirectory,
  protectedDirectoryLabel = 'installer checkout',
  protectedDirectoryInstruction = 'Move or clone Singularity Flow outside that workspace before a full reset.'
}) {
  const resolved = path.resolve(target);
  const filesystemRoot = path.parse(resolved).root;
  for (const forbidden of [filesystemRoot, path.resolve(homeDirectory), path.resolve(projectDirectory)]) {
    if (resolved === forbidden) throw new SingularityFlowError(`Refusing to delete broad or protected path: ${resolved}`);
  }
  if (inside(resolved, path.resolve(homeDirectory))) {
    throw new SingularityFlowError(
      `Refusing registered workspace root that contains the home directory: ${resolved}`
    );
  }
  if (inside(resolved, path.resolve(projectDirectory))) {
    throw new SingularityFlowError(
      `The ${protectedDirectoryLabel} is inside registered workspace ${resolved}. ${protectedDirectoryInstruction}`
    );
  }
}

async function managedCopilotSessions(sessionRoot) {
  const info = await existingDirectory(sessionRoot, 'Copilot session-state root');
  if (!info) return [];
  const targets = [];
  for (const entry of await readdir(sessionRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('singularity-')) continue;
    const target = path.join(sessionRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SingularityFlowError(`Singularity Copilot session state must not be a symbolic link: ${target}`);
    }
    if (!entry.isDirectory()) {
      throw new SingularityFlowError(`Singularity Copilot session state must be a directory: ${target}`);
    }
    targets.push(target);
  }
  return targets.sort();
}

function resetBlobIdentity(bytes, object) {
  const algorithm = object.length === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

async function resetRegularBytes(absolute) {
  const before = await lstat(absolute).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) return null;
  let handle;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    const after = await lstat(absolute).catch(() => null);
    if (!opened.isFile() || !after?.isFile() || after.isSymbolicLink()
        || (opened.ino && after.ino && (opened.ino !== after.ino || opened.dev !== after.dev))) return null;
    const bytes = await handle.readFile();
    return bytes.length === opened.size ? bytes : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Inspect index/worktree bytes without `git status`/`diff`, which can run clean/process filters.
 * All Git commands here only enumerate object/index names; Node hashes the actual regular files.
 */
async function checkoutChanges(project, environment) {
  const env = resetGitEnvironment(environment);
  const repository = run('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: project, env, allowFailure: true, timeoutClass: 'local-read'
  });
  if (repository.timedOut || repository.outputOverflow || repository.error || repository.signal) {
    return [{ status: '!!', file: '<checkout-state-unavailable>' }];
  }
  if (repository.status !== 0 || repository.stdout.trim() !== 'true') return [];
  const commit = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: project, env, allowFailure: true, timeoutClass: 'local-read'
  });
  const tree = commit.status === 0 ? run('git', ['ls-tree', '-rz', '--full-tree', commit.stdout.trim()], {
    cwd: project, env, allowFailure: true, timeoutClass: 'local-read'
  }) : { status: 1, stdout: '' };
  const index = run('git', ['ls-files', '--stage', '-z'], {
    cwd: project, env, allowFailure: true, timeoutClass: 'local-read'
  });
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: project, env, allowFailure: true, timeoutClass: 'local-read'
  });
  // `--exclude-standard` intentionally hides ignored content. That is appropriate for ordinary
  // source admission, but not when a reset is about to remove a whole generated directory: an
  // ignored private file inside that directory is still user data. Bound this extra inventory to
  // the only three roots the installer is ever allowed to classify for removal.
  const ignored = run('git', [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...INSTALLER_GENERATED_ROOTS
  ], {
    cwd: project, env, allowFailure: true, timeoutClass: 'local-read'
  });
  if (commit.status !== 0 || tree.status !== 0 || index.status !== 0 || untracked.status !== 0
      || ignored.status !== 0) {
    return [{ status: '!!', file: '<checkout-state-unavailable>' }];
  }

  const reviewed = new Map();
  for (const record of tree.stdout.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const [mode, type, object] = separator < 0 ? [] : record.slice(0, separator).split(' ');
    const relative = separator < 0 ? '' : record.slice(separator + 1);
    if (!mode || !type || !/^[a-f0-9]{40,64}$/u.test(object ?? '') || !relative
        || reviewed.has(relative)) return [{ status: '!!', file: '<malformed-reviewed-tree>' }];
    reviewed.set(relative, { mode, type, object });
  }
  const indexed = new Map();
  for (const record of index.stdout.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const [mode, object, stage] = separator < 0 ? [] : record.slice(0, separator).split(' ');
    const relative = separator < 0 ? '' : record.slice(separator + 1);
    if (!mode || !/^[a-f0-9]{40,64}$/u.test(object ?? '') || stage !== '0' || !relative
        || indexed.has(relative)) return [{ status: '!!', file: '<malformed-index>' }];
    indexed.set(relative, { mode, object });
  }

  const changes = [];
  for (const [relative, entry] of reviewed) {
    const indexEntry = indexed.get(relative);
    if (!indexEntry || indexEntry.mode !== entry.mode || indexEntry.object !== entry.object) {
      changes.push({ status: 'I ', file: relative });
      continue;
    }
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      changes.push({ status: 'T ', file: relative });
      continue;
    }
    const absolute = path.resolve(project, ...relative.split('/'));
    const within = path.relative(project, absolute);
    if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
      changes.push({ status: '!!', file: relative });
      continue;
    }
    const bytes = await resetRegularBytes(absolute);
    if (!bytes || resetBlobIdentity(bytes, entry.object) !== entry.object) {
      changes.push({ status: bytes ? ' M' : ' D', file: relative });
    }
  }
  for (const relative of indexed.keys()) {
    if (!reviewed.has(relative)) changes.push({ status: 'I ', file: relative });
  }
  for (const relative of untracked.stdout.split('\0').filter(Boolean)) {
    const components = relative.split('/');
    const unsafe = !relative || relative.startsWith('/') || relative.includes('\\')
      || /[\r\n\ufffd]/u.test(relative)
      || components.some((component) => !component || component === '.' || component === '..');
    changes.push({
      status: unsafe ? '!!' : '??',
      file: unsafe ? `unsafe-untracked:${JSON.stringify(relative)}` : relative
    });
  }
  for (const relative of ignored.stdout.split('\0').filter(Boolean)) {
    const components = relative.split('/');
    const unsafe = !relative || relative.startsWith('/') || relative.includes('\\')
      || /[\r\n\ufffd]/u.test(relative)
      || components.some((component) => !component || component === '.' || component === '..');
    changes.push({
      status: 'IG',
      file: unsafe ? `unsafe-ignored:${JSON.stringify(relative)}` : relative,
      relative
    });
  }
  return changes;
}

async function installerGeneratedState(project, environment, { rejectUnrelated = true } = {}) {
  const changes = await checkoutChanges(project, environment);
  // The reset primitive also supports an installed/non-repository project directory. In that
  // case there is no Git-proven generated root to remove. The guarded CLI separately requires and
  // admits an exact product checkout before it can call this primitive.
  if (!changes) return [];
  if (!changes.length) return [];
  const candidates = new Set();
  for (const change of changes) {
    if (change.status !== '??') continue;
    const root = INSTALLER_GENERATED_ROOTS.find((value) => change.file === value || change.file.startsWith(`${value}/`));
    if (root) candidates.add(root);
  }
  const ignoredInCandidates = changes.filter((change) => change.status === 'IG'
    && [...candidates].some((root) => {
      const relative = change.relative ?? change.file;
      return relative === root || relative.startsWith(`${root}/`);
    }));
  if (ignoredInCandidates.length) {
    throw new SingularityFlowError(
      'Refusing to delete generated installer state because it also contains ignored or private files:\n'
      + ignoredInCandidates.map((change) => `IG ${change.file}`).join('\n')
    );
  }
  const safeRoots = new Set();
  for (const root of candidates) {
    const tracked = run('git', ['ls-files', '--', root], {
      cwd: project,
      env: resetGitEnvironment(environment),
      allowFailure: true,
      timeoutClass: 'local-read'
    });
    if (tracked.status === 0 && !tracked.stdout.trim()) safeRoots.add(root);
  }
  const unrelated = changes.filter((change) => {
    if (change.status === 'IG') return false;
    if (change.status !== '??') return true;
    return ![...safeRoots].some((root) => change.file === root || change.file.startsWith(`${root}/`));
  });
  if (rejectUnrelated && unrelated.length) {
    throw new SingularityFlowError(
      `The installer checkout has changes outside generated reset state. Commit or stash them first:\n${unrelated.map((change) => `${change.status} ${change.file}`).join('\n')}`
    );
  }
  const targets = [];
  for (const root of [...safeRoots].sort()) {
    const target = path.join(project, root);
    const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SingularityFlowError(`Generated installer reset target must be a real directory: ${target}`);
    }
    targets.push(target);
  }
  return targets;
}

/**
 * Classify only installer-owned, wholly-untracked generated roots. This does not admit unrelated
 * changes: the caller must still run its complete source-cleanliness check. It exists so source
 * admission can distinguish a reset planner's reachable generated output from arbitrary input
 * before the destructive plan is finalized.
 */
export async function installerGeneratedResetPaths(projectDirectory, {
  environment = process.env
} = {}) {
  return installerGeneratedState(path.resolve(projectDirectory), environment, {
    rejectUnrelated: false
  });
}

/**
 * Build the complete boundary before changing anything. Destructive mode proves each registered
 * directory with its regular workspace.json. Forget-only inventories registrations without
 * opening, validating, or changing the physical workspace paths they name.
 */
async function machineResetPlan({
  homeDirectory = os.homedir(),
  projectDirectory = process.cwd(),
  environment = process.env,
  resolvedLocations = null,
  operation,
  confirmation,
  includeInstallerState,
  removeDirectSkills,
  forgetOnly = false,
  protectedDirectoryLabel,
  protectedDirectoryInstruction
} = {}) {
  const locations = resolvedLocations ?? await resolveMachineResetLocations({
    homeDirectory, projectDirectory, environment
  });
  const { home, project, localState, stateProofs } = locations;
  const localStateRoot = localState.path;
  const {
    registryFile,
    selectionFile,
    capabilityRegistryFile,
    capabilityCacheRoot,
    vscodeResetMarker,
    journalRoot
  } = Object.fromEntries(Object.entries(stateProofs).map(([key, proof]) => [key, proof.path]));
  const registryInfo = await lstat(registryFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  let registryWarning = null;
  if (registryInfo) {
    if (registryInfo.isSymbolicLink() || !registryInfo.isFile()) {
      throw new SingularityFlowError(`Workspace registry must be a regular file: ${registryFile}`);
    }
    try {
      const parsed = JSON.parse(await readFile(registryFile, 'utf8'));
      if (!Array.isArray(parsed) && !Array.isArray(parsed?.workspaces)) throw new Error('workspaces array is missing');
    } catch (error) {
      if (!forgetOnly) {
        throw new SingularityFlowError(`Refusing a full reset with an unreadable workspace registry ${registryFile}: ${error.message}`);
      }
      registryWarning = `Unreadable workspace registry will be forgotten without inspecting workspace directories: ${error.message}`;
    }
  }
  const entries = await readWorkspaceRegistry(registryFile);
  const workspaces = [];
  const missingRegistrations = [];
  const resetTargetProofs = new Map([[localStateRoot, localState]]);

  for (const entry of entries) {
    const workspaceProof = await resetTargetProof(entry.path, {
      label: `registered workspace '${entry.name ?? entry.id}'`, type: 'directory'
    });
    const target = workspaceProof.path;
    if (!workspaceProof.exists) {
      missingRegistrations.push(target);
      continue;
    }
    if (forgetOnly) {
      workspaces.push({
        id: entry.id,
        name: entry.name,
        path: target,
        disposition: 'preserved'
      });
      continue;
    }
    assertNarrowWorkspaceRoot(target, {
      homeDirectory: home,
      projectDirectory: project,
      protectedDirectoryLabel,
      protectedDirectoryInstruction
    });
    let manifest;
    try { manifest = await readWorkspace(target); }
    catch (error) {
      throw new SingularityFlowError(
        `Refusing to delete unproven registered workspace ${target}: ${error.message}`
      );
    }
    if (manifest.path !== target || manifest.id !== entry.id) {
      throw new SingularityFlowError(
        `Refusing to delete workspace whose manifest does not match its registration: ${target}`
      );
    }
    resetTargetProofs.set(target, workspaceProof);
    workspaces.push({ id: manifest.id, name: manifest.name, path: target, disposition: 'deleted' });
  }

  const sorted = workspaces.sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 1; !forgetOnly && index < sorted.length; index += 1) {
    if (inside(sorted[index - 1].path, sorted[index].path)) {
      throw new SingularityFlowError(
        `Registered workspace roots overlap and cannot be reset safely: ${sorted[index - 1].path} and ${sorted[index].path}`
      );
    }
  }

  const copilotSessionRoot = path.join(home, '.copilot', 'session-state');
  const copilotSessions = await managedCopilotSessions(copilotSessionRoot);
  const directSkillsProof = await resetTargetProof(
    copilotSkillsDirectory({ env: environment, homeDirectory: home }),
    { label: 'Copilot direct skills root', type: 'directory' }
  );
  const directSkillsRoot = directSkillsProof.path;
  const installerGeneratedPaths = includeInstallerState
    ? await installerGeneratedState(project, environment)
    : [];
  const defaultPaths = {
    registryFile: path.join(localStateRoot, 'workspaces.json'),
    selectionFile: path.join(localStateRoot, 'active-workspace.json'),
    capabilityRegistryFile: path.join(localStateRoot, 'leads.json'),
    capabilityCacheRoot: path.join(localStateRoot, 'organisation-cache'),
    vscodeResetMarker: path.join(localStateRoot, VSCODE_RESET_MARKER),
    journalRoot: path.join(localStateRoot, 'local-work-journal')
  };
  const targetCandidates = [
    { path: localStateRoot, type: 'directory', label: 'Singularity Flow machine state' },
    ...(registryFile === defaultPaths.registryFile ? []
      : [{ path: registryFile, type: 'file', label: 'custom workspace registry' }]),
    ...(selectionFile === defaultPaths.selectionFile ? []
      : [{ path: selectionFile, type: 'file', label: 'custom active-workspace selection' }]),
    ...(capabilityRegistryFile === defaultPaths.capabilityRegistryFile ? []
      : [{ path: capabilityRegistryFile, type: 'file', label: 'custom capability lead registry' }]),
    ...(capabilityCacheRoot === defaultPaths.capabilityCacheRoot ? []
      : [{ path: capabilityCacheRoot, type: 'directory', label: 'custom capability cache' }]),
    ...(vscodeResetMarker === defaultPaths.vscodeResetMarker ? []
      : [{ path: vscodeResetMarker, type: 'file', label: 'custom VS Code reset marker' }]),
    ...(journalRoot === defaultPaths.journalRoot ? []
      : [{ path: journalRoot, type: 'directory', label: 'custom local work journal' }]),
    ...copilotSessions.map((session) => ({
      path: session,
      type: 'directory',
      label: 'Singularity-named Copilot session state'
    }))
  ];
  for (const proof of Object.values(stateProofs)) resetTargetProofs.set(proof.path, proof);
  for (const session of copilotSessions) {
    resetTargetProofs.set(session, await resetTargetProof(session, {
      label: 'Singularity-named Copilot session state', type: 'directory'
    }));
  }
  resetTargetProofs.set(directSkillsRoot, directSkillsProof);
  for (const target of targetCandidates) {
    const overlappingWorkspace = sorted.find((workspace) => inside(workspace.path, target.path)
      || inside(target.path, workspace.path));
    if (overlappingWorkspace) {
      throw new SingularityFlowError(
        `Refusing machine-state target that overlaps registered workspace ${overlappingWorkspace.path}: ${path.resolve(target.path)}`
      );
    }
  }
  for (const target of targetCandidates) {
    await validateResetTarget(target.path, target);
    if (path.resolve(target.path) !== localStateRoot) {
      assertNarrowMachineTarget(target.path, {
        homeDirectory: home,
        projectDirectory: project,
        label: target.label
      });
    }
  }
  const machineTargets = deduplicateTargets(targetCandidates);
  for (const target of installerGeneratedPaths) {
    resetTargetProofs.set(target, await resetTargetProof(target, {
      label: 'generated installer reset target', type: 'directory'
    }));
  }
  const mode = forgetOnly ? 'forget-only' : 'delete-workspaces';
  const plan = {
    schemaVersion: 2,
    operation,
    mode,
    confirmation,
    projectDirectory: project,
    registryFile,
    selectionFile,
    localStateRoot,
    workspaces: sorted,
    missingRegistrations,
    registryWarning,
    copilotSessions,
    capabilityState: {
      registryFile: capabilityRegistryFile,
      cacheRoot: capabilityCacheRoot
    },
    journalState: { root: journalRoot, remoteSync: 'never' },
    vscodeReset: {
      marker: vscodeResetMarker,
      reset: [
        'credentials',
        'global-state',
        'acknowledgements',
        'pending-handoffs',
        'onboarding',
        'favorites',
        'persona',
        'global-extension-settings'
      ]
    },
    machineTargets,
    directSkillsRoot,
    removeDirectSkills,
    installerGeneratedPaths,
    remove: [
      ...installerGeneratedPaths.map((target) => `${target} (untracked Singularity state generated inside the installer checkout)`),
      ...(!forgetOnly ? sorted.map((workspace) =>
        `${workspace.path} (workspace '${workspace.name}', including every managed repository clone and document)`) : []),
      `${localStateRoot} (workspace registry, active selection, local sessions, caches, telemetry configuration, and recovery state)`,
      ...(registryFile === path.join(localStateRoot, 'workspaces.json') ? [] : [`${registryFile} (custom workspace registry)`]),
      ...(selectionFile === path.join(localStateRoot, 'active-workspace.json') ? [] : [`${selectionFile} (custom active-workspace selection)`]),
      ...(capabilityRegistryFile === path.join(localStateRoot, 'leads.json') ? []
        : [`${capabilityRegistryFile} (custom capability lead registry)`]),
      ...(capabilityCacheRoot === path.join(localStateRoot, 'organisation-cache') ? []
        : [`${capabilityCacheRoot} (custom capability and organisation cache)`]),
      ...(journalRoot === path.join(localStateRoot, 'local-work-journal') ? []
        : [`${journalRoot} (custom private local work journal)`]),
      ...copilotSessions.map((session) => `${session} (Singularity-named Copilot session state)`),
      ...(removeDirectSkills ? [`${directSkillsRoot}/sf-* managed skill aliases`] : []),
      ...(includeInstallerState
        ? ['installed singularity-flow Copilot plugin copies, global npm package, and VS Code extension (removed by install.sh before reinstall)']
        : []),
      `Singularity Flow Jira, Teams, indexed provider credentials, onboarding profile, and extension global state (cleared when the ${includeInstallerState ? 'reinstalled ' : ''}VS Code extension next activates)`
    ],
    preserve: [
      includeInstallerState
        ? 'this installer checkout, its tracked source, and its Git history'
        : (forgetOnly
          ? 'every registered workspace directory, repository clone, branch, worktree, manifest, dirty file, and repository-local recovery record'
          : 'the current directory and every repository outside validated registered workspace roots'),
      ...(forgetOnly
        ? ['remote capability maps, sflow/config and state branches, proposals, Git history, application files, and repository-owned .vscode/settings.json']
        : []),
      'unregistered application directories and repositories',
      'personal Copilot skills without the Singularity managed marker',
      ...(!removeDirectSkills
        ? ['the installed CLI, VS Code extension, Copilot plugin, and managed /sf-* skills']
        : [])
    ]
  };
  Object.defineProperty(plan, RESET_TARGET_PROOFS, {
    value: resetTargetProofs,
    enumerable: false
  });
  return plan;
}

export async function freshInstallResetPlan(options = {}) {
  return machineResetPlan({
    ...options,
    operation: 'fresh-install-reset',
    confirmation: FRESH_INSTALL_CONFIRMATION,
    includeInstallerState: true,
    removeDirectSkills: true,
    protectedDirectoryLabel: 'installer checkout',
    protectedDirectoryInstruction: 'Move or clone Singularity Flow outside that workspace before a full reset.'
  });
}

/** Preview either machine-state-only cleanup or validated workspace deletion. */
export async function localResetPlan(options = {}) {
  const forgetOnly = options.forgetOnly === true;
  return machineResetPlan({
    ...options,
    operation: 'local-reset',
    confirmation: forgetOnly ? LOCAL_FORGET_CONFIRMATION : LOCAL_RESET_CONFIRMATION,
    forgetOnly,
    includeInstallerState: false,
    removeDirectSkills: false,
    protectedDirectoryLabel: 'current working directory',
    protectedDirectoryInstruction: 'Run local-reset from a directory outside every managed workspace.'
  });
}

async function moveToStaging(target, records, proof) {
  if (!proof) throw new SingularityFlowError(`Reset target has no canonical proof: ${target}`);
  const verified = await assertResetTargetProof(proof);
  if (!verified.exists) return;
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info || !sameResetTargetIdentity(resetTargetIdentity(info), proof.identity)) {
    throw new SingularityFlowError(`${proof.label} changed immediately before staging: ${proof.requestedPath}`);
  }
  if (info.isSymbolicLink()) throw new SingularityFlowError(`Reset target became a symbolic link: ${target}`);
  const staging = await mkdtemp(path.join(path.dirname(target), '.sflow-fresh-install-'));
  const backup = path.join(staging, 'content');
  await rename(target, backup);
  records.push({ target, staging, backup });
  const movedInfo = await lstat(backup);
  if (!sameResetTargetIdentity(resetTargetIdentity(movedInfo), proof.identity)) {
    throw new SingularityFlowError(`${proof.label} identity changed during staging: ${proof.requestedPath}`);
  }
}

async function moveMachineStateContentsToStaging(target, records, lockPaths, proof) {
  if (!proof) throw new SingularityFlowError(`Machine-state target has no canonical proof: ${target}`);
  const verified = await assertResetTargetProof(proof);
  if (!verified.exists) return;
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info || !sameResetTargetIdentity(resetTargetIdentity(info), proof.identity)) {
    throw new SingularityFlowError(`${proof.label} changed immediately before staging: ${proof.requestedPath}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SingularityFlowError(`Singularity Flow machine state must be a real directory: ${target}`);
  }
  const staging = await mkdtemp(path.join(path.dirname(target), '.sflow-fresh-install-'));
  const backup = path.join(staging, 'content');
  await mkdir(backup);
  const moved = [];
  try {
    for (const entry of await readdir(target, { withFileTypes: true })) {
      const current = path.join(target, entry.name);
      if (lockPaths.has(current)) continue;
      const saved = path.join(backup, entry.name);
      await rename(current, saved);
      moved.push({ current, backup: saved });
    }
  } catch (error) {
    const failures = [];
    for (const entry of [...moved].reverse()) {
      const replacement = await lstat(entry.current).catch((stateError) =>
        stateError?.code === 'ENOENT' ? null : Promise.reject(stateError));
      if (replacement) {
        failures.push(`${entry.current}: a concurrent machine-state entry now occupies this path`);
        continue;
      }
      await rename(entry.backup, entry.current).catch((restoreError) => {
        failures.push(`${entry.current}: ${restoreError.message}`);
      });
    }
    if (!failures.length) await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (failures.length) {
      throw new SingularityFlowError(
        `Machine-state staging failed and rollback was incomplete (${failures.join('; ')}). `
        + `The unrestored previous state remains in ${staging}. Original error: ${error.message}`
      );
    }
    throw error;
  }
  records.push({ target, staging, backup, moved, contentsOnly: true });
}

async function restoreMoved(records) {
  const failures = [];
  for (const record of [...records].reverse()) {
    if (record.contentsOnly) {
      const failuresBeforeRecord = failures.length;
      for (const entry of [...record.moved].reverse()) {
        const replacement = await lstat(entry.current).catch((error) =>
          error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (replacement) {
          failures.push(`${entry.current}: a concurrent machine-state entry now occupies this path`);
          continue;
        }
        try { await rename(entry.backup, entry.current); }
        catch (error) { failures.push(`${entry.current}: ${error.message}`); }
      }
      if (failures.length === failuresBeforeRecord) {
        await rm(record.staging, { recursive: true, force: true }).catch((error) => {
          failures.push(`${record.staging}: ${error.message}`);
        });
      } else {
        failures.push(`the unrestored previous machine state remains in ${record.staging}`);
      }
      continue;
    }
    try {
      const replacement = await lstat(record.target).catch((error) =>
        error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (replacement) {
        failures.push(`${record.target}: a concurrent entry now occupies this path`);
        continue;
      }
      await rename(record.backup, record.target);
      await rm(record.staging, { recursive: true, force: true });
    } catch (error) { failures.push(`${record.target}: ${error.message}`); }
  }
  return failures;
}

async function ensureCanonicalResetDirectory(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info = await lstat(current).catch((error) =>
      error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) {
      await mkdir(current, { mode: 0o700 }).catch((error) => {
        if (error?.code !== 'EEXIST') throw error;
      });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SingularityFlowError(`${label} parent became unsafe: ${current}`);
    }
    const canonical = await realpath(current);
    if (!sameResetPathIdentity(canonical, current)) {
      throw new SingularityFlowError(`${label} parent changed through a symbolic link: ${current}`);
    }
  }
}

async function writeResetMarker(file, value) {
  await ensureCanonicalResetDirectory(path.dirname(file), 'VS Code reset marker');
  let handle;
  try {
    handle = await open(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(value, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ELOOP') {
      throw new SingularityFlowError(`VS Code reset marker changed before it could be written safely: ${file}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function applyMachineReset(plan, { confirmation, fault = null }, { lockPaths }) {
  if (confirmation !== plan.confirmation) {
    throw new SingularityFlowError(
      `${plan.operation === 'local-reset' ? 'Local reset' : 'Fresh install reset'} requires exact confirmation '${plan.confirmation}'. Run with --dry-run first.`
    );
  }
  const moved = [];
  let markerWritten = false;
  const proofs = plan[RESET_TARGET_PROOFS];
  if (!(proofs instanceof Map)) throw new SingularityFlowError('Reset plan has no canonical target proofs. Preview it again.');
  try {
    for (const target of plan.installerGeneratedPaths) {
      await moveToStaging(target, moved, proofs.get(path.resolve(target)));
    }
    for (const workspace of plan.workspaces.filter((entry) => entry.disposition === 'deleted')) {
      await moveToStaging(workspace.path, moved, proofs.get(path.resolve(workspace.path)));
    }
    for (const target of plan.machineTargets) {
      if (path.resolve(target.path) === path.resolve(plan.localStateRoot)) {
        await moveMachineStateContentsToStaging(
          target.path, moved, lockPaths, proofs.get(path.resolve(target.path))
        );
      } else {
        await moveToStaging(target.path, moved, proofs.get(path.resolve(target.path)));
      }
      if (fault) await fault(`after-move:${target.label}`, plan);
    }
    if (plan.removeDirectSkills) {
      await assertResetTargetProof(proofs.get(path.resolve(plan.directSkillsRoot)));
      uninstallDirectSkills({ targetRoot: plan.directSkillsRoot });
    }
    const vscodeResetMarker = plan.vscodeReset.marker;
    await writeResetMarker(vscodeResetMarker, `${JSON.stringify({
      schemaVersion: currentSchemaVersion('vscode-reset-marker'),
      requestedAt: new Date().toISOString(),
      mode: plan.mode,
      reset: plan.vscodeReset.reset
    }, null, 2)}\n`);
    markerWritten = true;
    fault?.('after-vscode-reset-marker', plan);
    for (const record of moved) await rm(record.staging, { recursive: true, force: true });
    return { ...plan, completed: true, vscodeResetMarker };
  } catch (error) {
    if (markerWritten) await rm(plan.vscodeReset.marker, { force: true }).catch(() => {});
    const failures = await restoreMoved(moved);
    if (failures.length) {
      throw new SingularityFlowError(
        `${plan.operation === 'local-reset' ? 'Local reset' : 'Fresh reset'} failed and rollback was incomplete (${failures.join('; ')}). Original error: ${error.message}`
      );
    }
    throw error;
  }
}

/** Delete only the boundary proven by freshInstallResetPlan. Reinstallation remains install.sh's job. */
export async function freshInstallReset(options = {}) {
  const lockLocations = await resolveMachineResetLocations(options);
  const localStateRoot = lockLocations.localState.path;
  const state = Object.fromEntries(Object.entries(lockLocations.stateProofs)
    .map(([key, proof]) => [key, proof.path]));
  return withMachineStateResetBarrier({
    localStateRoot,
    registryFiles: [state.registryFile, state.selectionFile, state.capabilityRegistryFile]
  }, async (barrier) => {
    const resolvedLocations = await resolveMachineResetLocations(options);
    assertSameResetLocations(lockLocations, resolvedLocations);
    const plan = await freshInstallResetPlan({ ...options, resolvedLocations });
    return applyMachineReset(plan, options, barrier);
  });
}

/** Apply the selected local mode while preserving every installed product surface. */
export async function localReset(options = {}) {
  const lockLocations = await resolveMachineResetLocations(options);
  const localStateRoot = lockLocations.localState.path;
  const state = Object.fromEntries(Object.entries(lockLocations.stateProofs)
    .map(([key, proof]) => [key, proof.path]));
  return withMachineStateResetBarrier({
    localStateRoot,
    registryFiles: [state.registryFile, state.selectionFile, state.capabilityRegistryFile]
  }, async (barrier) => {
    const resolvedLocations = await resolveMachineResetLocations(options);
    assertSameResetLocations(lockLocations, resolvedLocations);
    const plan = await localResetPlan({ ...options, resolvedLocations });
    return applyMachineReset(plan, options, barrier);
  });
}
