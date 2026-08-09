import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { copilotSkillsDirectory, uninstallDirectSkills } from './direct-skills.mjs';
import { machineStateRoot } from './factory-reset.mjs';
import { readWorkspace, readWorkspaceRegistry } from './workspace.mjs';
import { activeWorkspaceFile, workspaceRegistryFile } from './workspace-context.mjs';
import { run, SingularityFlowError } from './util.mjs';

export const FRESH_INSTALL_CONFIRMATION = 'RESET EVERYTHING';
export const LOCAL_RESET_CONFIRMATION = 'RESET LOCAL';
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
  return (await readdir(sessionRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('singularity-'))
    .map((entry) => path.join(sessionRoot, entry.name))
    .sort();
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
 * Build the complete destructive boundary before changing anything. A registered directory is
 * deletable only when its own regular workspace.json validates and resolves back to that exact
 * directory. A stale missing registration is harmless; an existing ambiguous path blocks reset.
 */
async function machineResetPlan({
  homeDirectory = os.homedir(),
  projectDirectory = process.cwd(),
  environment = process.env,
  operation,
  confirmation,
  includeInstallerState,
  removeDirectSkills,
  protectedDirectoryLabel,
  protectedDirectoryInstruction
} = {}) {
  const home = path.resolve(homeDirectory);
  const project = path.resolve(projectDirectory);
  const registryFile = workspaceRegistryFile(environment, home);
  const selectionFile = activeWorkspaceFile(environment, home);
  const localStateRoot = machineStateRoot(home);
  const registryInfo = await lstat(registryFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (registryInfo) {
    if (registryInfo.isSymbolicLink() || !registryInfo.isFile()) {
      throw new SingularityFlowError(`Workspace registry must be a regular file: ${registryFile}`);
    }
    try {
      const parsed = JSON.parse(await readFile(registryFile, 'utf8'));
      if (!Array.isArray(parsed) && !Array.isArray(parsed?.workspaces)) throw new Error('workspaces array is missing');
    } catch (error) {
      throw new SingularityFlowError(`Refusing a full reset with an unreadable workspace registry ${registryFile}: ${error.message}`);
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
    workspaces.push({ id: manifest.id, name: manifest.name, path: target });
  }

  const sorted = workspaces.sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 1; index < sorted.length; index += 1) {
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
  return {
    schemaVersion: 1,
    operation,
    confirmation,
    projectDirectory: project,
    registryFile,
    selectionFile,
    localStateRoot,
    workspaces: sorted,
    missingRegistrations,
    copilotSessions,
    directSkillsRoot,
    removeDirectSkills,
    installerGeneratedPaths,
    remove: [
      ...installerGeneratedPaths.map((target) => `${target} (untracked Singularity state generated inside the installer checkout)`),
      ...sorted.map((workspace) => `${workspace.path} (workspace '${workspace.name}', including every managed repository clone and document)`),
      `${localStateRoot} (workspace registry, active selection, local sessions, caches, telemetry configuration, and recovery state)`,
      ...(registryFile === path.join(localStateRoot, 'workspaces.json') ? [] : [`${registryFile} (custom workspace registry)`]),
      ...(selectionFile === path.join(localStateRoot, 'active-workspace.json') ? [] : [`${selectionFile} (custom active-workspace selection)`]),
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
        : 'the current directory and every repository outside validated registered workspace roots',
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

/**
 * Preview a clean local Singularity state without uninstalling the product. Only workspace roots
 * proven by their registry entry and matching workspace.json are eligible for deletion.
 */
export async function localResetPlan(options = {}) {
  return machineResetPlan({
    ...options,
    operation: 'local-reset',
    confirmation: LOCAL_RESET_CONFIRMATION,
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

async function applyMachineReset(plan, { confirmation }) {
  if (confirmation !== plan.confirmation) {
    throw new SingularityFlowError(
      `${plan.operation === 'local-reset' ? 'Local reset' : 'Fresh install reset'} requires exact confirmation '${plan.confirmation}'. Run with --dry-run first.`
    );
  }
  const moved = [];
  try {
    for (const target of plan.installerGeneratedPaths) await moveToStaging(target, moved);
    for (const workspace of plan.workspaces) await moveToStaging(workspace.path, moved);
    await moveToStaging(plan.localStateRoot, moved);
    if (!inside(plan.localStateRoot, plan.registryFile)) await moveToStaging(plan.registryFile, moved);
    if (!inside(plan.localStateRoot, plan.selectionFile)) await moveToStaging(plan.selectionFile, moved);
    for (const session of plan.copilotSessions) await moveToStaging(session, moved);
    if (plan.removeDirectSkills) uninstallDirectSkills({ targetRoot: plan.directSkillsRoot });
    await mkdir(plan.localStateRoot, { recursive: true, mode: 0o700 });
    const vscodeResetMarker = path.join(plan.localStateRoot, VSCODE_RESET_MARKER);
    await writeFile(vscodeResetMarker, `${JSON.stringify({
      schemaVersion: 1,
      requestedAt: new Date().toISOString(),
      reset: ['credentials', 'onboarding', 'extension-global-state']
    }, null, 2)}\n`, { mode: 0o600 });
    for (const record of moved) await rm(record.staging, { recursive: true, force: true });
    return { ...plan, completed: true, vscodeResetMarker };
  } catch (error) {
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

/** Delete validated workspaces and local runtime state while preserving every installed surface. */
export async function localReset(options = {}) {
  const plan = await localResetPlan(options);
  return applyMachineReset(plan, options);
}
