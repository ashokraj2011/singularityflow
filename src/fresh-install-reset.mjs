import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { copilotSkillsDirectory, uninstallDirectSkills } from './direct-skills.mjs';
import { machineStateRoot } from './factory-reset.mjs';
import { readWorkspace, readWorkspaceRegistry } from './workspace.mjs';
import { activeWorkspaceFile, workspaceRegistryFile } from './workspace-context.mjs';
import { run, SingularityFlowError } from './util.mjs';
import { localWorkJournalRoot } from './local-work-journal.mjs';

export const FRESH_INSTALL_CONFIRMATION = 'RESET EVERYTHING';
export const LOCAL_RESET_CONFIRMATION = 'RESET LOCAL';
export const LOCAL_FORGET_CONFIRMATION = 'FORGET LOCAL';
export const VSCODE_RESET_MARKER = 'vscode-fresh-reset-pending.json';
const INSTALLER_GENERATED_ROOTS = ['singularity', '.singularity', '.github/agents'];

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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

function assertNarrowMachineDirectory(target, { homeDirectory, projectDirectory, label }) {
  const resolved = path.resolve(target);
  const forbidden = [path.parse(resolved).root, path.resolve(homeDirectory), path.resolve(projectDirectory)];
  if (forbidden.includes(resolved) || inside(resolved, path.resolve(homeDirectory))
    || inside(resolved, path.resolve(projectDirectory))) {
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

function assertNarrowWorkspaceRoot(target, {
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

function checkoutChanges(project) {
  const result = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: project,
    allowFailure: true
  });
  if (result.status !== 0) return [];
  const chunks = result.stdout.split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const record = chunks[index];
    const status = record.slice(0, 2);
    const file = record.slice(3);
    changes.push({ status, file });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return changes;
}

async function installerGeneratedState(project) {
  const changes = checkoutChanges(project);
  if (!changes.length) return [];
  const candidates = new Set();
  for (const change of changes) {
    if (change.status !== '??') continue;
    const root = INSTALLER_GENERATED_ROOTS.find((value) => change.file === value || change.file.startsWith(`${value}/`));
    if (root) candidates.add(root);
  }
  const safeRoots = new Set();
  for (const root of candidates) {
    const tracked = run('git', ['ls-files', '--', root], { cwd: project, allowFailure: true });
    if (tracked.status === 0 && !tracked.stdout.trim()) safeRoots.add(root);
  }
  const unrelated = changes.filter((change) => {
    if (change.status !== '??') return true;
    return ![...safeRoots].some((root) => change.file === root || change.file.startsWith(`${root}/`));
  });
  if (unrelated.length) {
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
 * Build the complete boundary before changing anything. Destructive mode proves each registered
 * directory with its regular workspace.json. Forget-only inventories registrations without
 * opening, validating, or changing the physical workspace paths they name.
 */
async function machineResetPlan({
  homeDirectory = os.homedir(),
  projectDirectory = process.cwd(),
  environment = process.env,
  operation,
  confirmation,
  includeInstallerState,
  removeDirectSkills,
  forgetOnly = false,
  protectedDirectoryLabel,
  protectedDirectoryInstruction
} = {}) {
  const home = path.resolve(homeDirectory);
  const project = path.resolve(projectDirectory);
  const localStateRoot = machineStateRoot(home);
  const {
    registryFile,
    selectionFile,
    capabilityRegistryFile,
    capabilityCacheRoot,
    vscodeResetMarker,
    journalRoot
  } = machineStatePaths(environment, home, localStateRoot);
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

  for (const entry of entries) {
    const target = path.resolve(entry.path);
    const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) {
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
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SingularityFlowError(`Registered workspace is not a real directory: ${target}`);
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
  const directSkillsRoot = copilotSkillsDirectory({ env: environment, homeDirectory: home });
  const installerGeneratedPaths = includeInstallerState ? await installerGeneratedState(project) : [];
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
    if (target.type === 'directory' && path.resolve(target.path) !== localStateRoot) {
      assertNarrowMachineDirectory(target.path, {
        homeDirectory: home,
        projectDirectory: project,
        label: target.label
      });
    }
  }
  const machineTargets = deduplicateTargets(targetCandidates);
  const mode = forgetOnly ? 'forget-only' : 'delete-workspaces';
  return {
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

async function moveToStaging(target, records) {
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return;
  if (info.isSymbolicLink()) throw new SingularityFlowError(`Reset target became a symbolic link: ${target}`);
  const staging = await mkdtemp(path.join(path.dirname(target), '.sflow-fresh-install-'));
  const backup = path.join(staging, 'content');
  await rename(target, backup);
  records.push({ target, staging, backup });
}

async function restoreMoved(records) {
  const failures = [];
  for (const record of [...records].reverse()) {
    try {
      await rm(record.target, { recursive: true, force: true });
      await rename(record.backup, record.target);
      await rm(record.staging, { recursive: true, force: true });
    } catch (error) { failures.push(`${record.target}: ${error.message}`); }
  }
  return failures;
}

async function applyMachineReset(plan, { confirmation, fault = null }) {
  if (confirmation !== plan.confirmation) {
    throw new SingularityFlowError(
      `${plan.operation === 'local-reset' ? 'Local reset' : 'Fresh install reset'} requires exact confirmation '${plan.confirmation}'. Run with --dry-run first.`
    );
  }
  const moved = [];
  let markerWritten = false;
  try {
    for (const target of plan.installerGeneratedPaths) await moveToStaging(target, moved);
    for (const workspace of plan.workspaces.filter((entry) => entry.disposition === 'deleted')) {
      await moveToStaging(workspace.path, moved);
    }
    for (const target of plan.machineTargets) {
      await moveToStaging(target.path, moved);
      fault?.(`after-move:${target.label}`, plan);
    }
    if (plan.removeDirectSkills) uninstallDirectSkills({ targetRoot: plan.directSkillsRoot });
    const vscodeResetMarker = plan.vscodeReset.marker;
    await mkdir(path.dirname(vscodeResetMarker), { recursive: true, mode: 0o700 });
    await writeFile(vscodeResetMarker, `${JSON.stringify({
      schemaVersion: 2,
      requestedAt: new Date().toISOString(),
      mode: plan.mode,
      reset: plan.vscodeReset.reset
    }, null, 2)}\n`, { mode: 0o600 });
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
  const plan = await freshInstallResetPlan(options);
  return applyMachineReset(plan, options);
}

/** Apply the selected local mode while preserving every installed product surface. */
export async function localReset(options = {}) {
  const plan = await localResetPlan(options);
  return applyMachineReset(plan, options);
}
