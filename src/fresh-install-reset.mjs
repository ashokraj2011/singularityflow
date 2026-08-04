import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { copilotSkillsDirectory, uninstallDirectSkills } from './direct-skills.mjs';
import { machineStateRoot } from './factory-reset.mjs';
import { readWorkspace, readWorkspaceRegistry } from './workspace.mjs';
import { activeWorkspaceFile, workspaceRegistryFile } from './workspace-context.mjs';
import { SingularityFlowError } from './util.mjs';

export const FRESH_INSTALL_CONFIRMATION = 'RESET EVERYTHING';
export const VSCODE_RESET_MARKER = 'vscode-fresh-reset-pending.json';

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

function assertNarrowWorkspaceRoot(target, { homeDirectory, projectDirectory }) {
  const resolved = path.resolve(target);
  const filesystemRoot = path.parse(resolved).root;
  for (const forbidden of [filesystemRoot, path.resolve(homeDirectory), path.resolve(projectDirectory)]) {
    if (resolved === forbidden) throw new SingularityFlowError(`Refusing to delete broad or protected path: ${resolved}`);
  }
  if (inside(resolved, path.resolve(projectDirectory))) {
    throw new SingularityFlowError(
      `The installer checkout is inside registered workspace ${resolved}. Move or clone Singularity Flow outside that workspace before a full reset.`
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

/**
 * Build the complete destructive boundary before changing anything. A registered directory is
 * deletable only when its own regular workspace.json validates and resolves back to that exact
 * directory. A stale missing registration is harmless; an existing ambiguous path blocks reset.
 */
export async function freshInstallResetPlan({
  homeDirectory = os.homedir(),
  projectDirectory = process.cwd(),
  environment = process.env
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
    assertNarrowWorkspaceRoot(target, { homeDirectory: home, projectDirectory: project });
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
  return {
    schemaVersion: 1,
    operation: 'fresh-install-reset',
    confirmation: FRESH_INSTALL_CONFIRMATION,
    projectDirectory: project,
    registryFile,
    selectionFile,
    localStateRoot,
    workspaces: sorted,
    missingRegistrations,
    copilotSessions,
    directSkillsRoot,
    remove: [
      ...sorted.map((workspace) => `${workspace.path} (workspace '${workspace.name}', including every managed repository clone and document)`),
      `${localStateRoot} (workspace registry, active selection, local sessions, caches, telemetry configuration, and recovery state)`,
      ...(registryFile === path.join(localStateRoot, 'workspaces.json') ? [] : [`${registryFile} (custom workspace registry)`]),
      ...(selectionFile === path.join(localStateRoot, 'active-workspace.json') ? [] : [`${selectionFile} (custom active-workspace selection)`]),
      ...copilotSessions.map((session) => `${session} (Singularity-named Copilot session state)`),
      `${directSkillsRoot}/sf-* managed skill aliases`,
      'installed singularity-flow Copilot plugin copies, global npm package, and VS Code extension (removed by install.sh before reinstall)',
      'Singularity Flow Jira, Teams, indexed provider credentials, onboarding profile, and extension global state (cleared when the reinstalled VS Code extension next activates)'
    ],
    preserve: [
      'this installer checkout and its Git history',
      'unregistered application directories and repositories',
      'personal Copilot skills without the Singularity managed marker'
    ]
  };
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

/** Delete only the boundary proven by freshInstallResetPlan. Reinstallation remains install.sh's job. */
export async function freshInstallReset(options = {}) {
  const plan = await freshInstallResetPlan(options);
  if (options.confirmation !== FRESH_INSTALL_CONFIRMATION) {
    throw new SingularityFlowError(
      `Fresh install reset requires exact confirmation '${FRESH_INSTALL_CONFIRMATION}'. Preview it without --yes first.`
    );
  }
  const moved = [];
  try {
    for (const workspace of plan.workspaces) await moveToStaging(workspace.path, moved);
    await moveToStaging(plan.localStateRoot, moved);
    if (!inside(plan.localStateRoot, plan.registryFile)) await moveToStaging(plan.registryFile, moved);
    if (!inside(plan.localStateRoot, plan.selectionFile)) await moveToStaging(plan.selectionFile, moved);
    for (const session of plan.copilotSessions) await moveToStaging(session, moved);
    uninstallDirectSkills({ targetRoot: plan.directSkillsRoot });
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
        `Fresh reset failed and rollback was incomplete (${failures.join('; ')}). Original error: ${error.message}`
      );
    }
    throw error;
  }
}
