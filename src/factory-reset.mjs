import path from 'node:path';
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { branch, gitDir, head } from './git.mjs';
import { initializeDefinition, loadDefinition } from './config.mjs';
import { SingularityFlowError, run } from './util.mjs';

const CONTROL_ROOTS = ['singularity', '.singularity'];
const LOCAL_RUNTIME_ROOT = 'singularity-flow';

async function directoryState(target, label) {
  const info = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { exists: false, target };
  if (info.isSymbolicLink()) throw new SingularityFlowError(`${label} must not be a symbolic link: ${target}`);
  if (!info.isDirectory()) throw new SingularityFlowError(`${label} must be a directory: ${target}`);
  return { exists: true, target };
}

async function regularFiles(root, relative = '', output = []) {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) await regularFiles(root, child, output);
    else if (entry.isFile()) output.push(child);
  }
  return output.sort();
}

function changedResetPaths(root) {
  const result = run('git', ['status', '--porcelain', '--', 'singularity', '.singularity', '.github/agents'], {
    cwd: root,
    allowFailure: true
  });
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export async function factoryResetPlan(root, { packageVersion = null } = {}) {
  const repository = path.resolve(root);
  const localRuntime = path.join(gitDir(repository), LOCAL_RUNTIME_ROOT);
  await directoryState(path.join(repository, 'singularity'), 'Singularity control root');
  await directoryState(path.join(repository, '.singularity'), 'Legacy Singularity control root');
  await directoryState(localRuntime, 'Singularity local runtime root');
  const confirmation = `RESET ${path.basename(repository)}`;
  return {
    schemaVersion: 1,
    operation: 'factory-reset',
    repository,
    branch: branch(repository),
    head: head(repository),
    packageVersion,
    confirmation,
    remove: [
      'singularity/ (workflow, lifecycle state, generated artifacts, templates, prompts, and world model)',
      '.singularity/ (legacy configuration, when present)',
      `${localRuntime} (sessions, choices, locks, telemetry, caches, and pending-publication recovery)`
    ],
    replace: [
      'singularity/ from the templates bundled with the currently installed npm package',
      'bundled .github/agents/*.agent.md files from that package'
    ],
    preserve: [
      'application source and every file outside the listed reset roots',
      '.git history, branches, tags, remotes, index, and configuration',
      'custom .github/agents files whose names are not supplied by the npm package',
      'the global workspace registry and workspace clones'
    ],
    uncommittedResetPaths: changedResetPaths(repository)
  };
}

async function restoreDirectory(current, backup, existed) {
  await rm(current, { recursive: true, force: true });
  if (existed) await rename(backup, current);
}

export async function factoryResetRepository(root, {
  confirmation,
  packageVersion = null
} = {}) {
  const plan = await factoryResetPlan(root, { packageVersion });
  if (confirmation !== plan.confirmation) {
    throw new SingularityFlowError(
      `Factory reset requires exact confirmation '${plan.confirmation}'. Run with --dry-run first, then pass --confirm ${JSON.stringify(plan.confirmation)}.`
    );
  }

  const repository = plan.repository;
  const staging = await mkdtemp(path.join(repository, '.sflow-factory-reset-'));
  const fresh = path.join(staging, 'fresh');
  const backup = path.join(staging, 'backup');
  const control = path.join(repository, 'singularity');
  const legacy = path.join(repository, '.singularity');
  const backupControl = path.join(backup, 'singularity');
  const backupLegacy = path.join(backup, '.singularity');
  const freshAgents = path.join(fresh, '.github', 'agents');
  const targetAgents = path.join(repository, '.github', 'agents');
  const backupAgents = path.join(backup, 'agents');
  const localRuntime = path.join(gitDir(repository), LOCAL_RUNTIME_ROOT);
  let controlExisted = false;
  let legacyExisted = false;
  const agentBackups = [];
  let installedAgents = [];
  let completed = false;

  try {
    await mkdir(fresh, { recursive: true });
    await initializeDefinition(fresh);
    await loadDefinition(fresh);
    installedAgents = await regularFiles(freshAgents);
    await mkdir(backup, { recursive: true });

    controlExisted = (await directoryState(control, 'Singularity control root')).exists;
    legacyExisted = (await directoryState(legacy, 'Legacy Singularity control root')).exists;
    if (controlExisted) await rename(control, backupControl);
    if (legacyExisted) await rename(legacy, backupLegacy);
    await cp(path.join(fresh, 'singularity'), control, { recursive: true, force: false });

    for (const relative of installedAgents) {
      const source = path.join(freshAgents, relative);
      const target = path.join(targetAgents, relative);
      const previous = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (previous?.isSymbolicLink()) throw new SingularityFlowError(`Bundled agent target must not be a symbolic link: ${target}`);
      if (previous && !previous.isFile()) throw new SingularityFlowError(`Bundled agent target must be a regular file: ${target}`);
      if (previous) {
        const saved = path.join(backupAgents, relative);
        await mkdir(path.dirname(saved), { recursive: true });
        await cp(target, saved);
      }
      agentBackups.push({ relative, existed: Boolean(previous) });
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true });
    }

    // Validate the exact files now installed in the repository before removing the old local
    // runtime. The installed npm package is the source of the replacement, not the checkout's
    // previous configuration.
    await loadDefinition(repository);
    await rm(localRuntime, { recursive: true, force: true });
    completed = true;
    return {
      ...plan,
      completed: true,
      installedAgents: installedAgents.map((file) => path.posix.join('.github/agents', file)),
      next: [
        'Review git diff -- singularity .github/agents',
        'Run singularity-flow init --check',
        'Commit the reset on the current branch when the replacement is correct'
      ]
    };
  } catch (error) {
    await restoreDirectory(control, backupControl, controlExisted).catch(() => {});
    await restoreDirectory(legacy, backupLegacy, legacyExisted).catch(() => {});
    for (const record of agentBackups.reverse()) {
      const target = path.join(targetAgents, record.relative);
      if (record.existed) {
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(backupAgents, record.relative), target, { force: true }).catch(() => {});
      } else await rm(target, { force: true }).catch(() => {});
    }
    throw error;
  } finally {
    // Once the replacement validates, the backup is deliberately destroyed: Git history is the
    // recovery path and a factory reset must not leave a second local state tree behind.
    await rm(staging, { recursive: true, force: true });
    if (!completed) {
      // No-op: the catch block restored every path before this cleanup.
    }
  }
}
