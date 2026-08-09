import path from 'node:path';
import os from 'node:os';
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { branch, gitDir, head } from './git.mjs';
import { initializeDefinition, loadDefinition } from './config.mjs';
import { SingularityFlowError, run } from './util.mjs';

const CONTROL_ROOTS = ['singularity', '.singularity'];
const LOCAL_RUNTIME_ROOT = 'singularity-flow';
const RESET_ALL_CONFIRMATION = 'RESET ALL';

export function machineStateRoot(home = os.homedir()) {
  return path.join(home, '.singularity-flow');
}

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
  // Fail closed. This list is the only thing standing between an operator's uncommitted work and an
  // `rm -rf` of the control root, and the guard's premise is that Git history is the recovery path —
  // which is exactly the claim that does not hold for uncommitted files. Returning an empty list on
  // a failed `git status` (a concurrent operation holding index.lock is enough) reported "nothing
  // uncommitted" and deleted the work anyway.
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `Cannot determine whether ${root} has uncommitted governed changes: `
      + `${(result.stderr || result.stdout).trim().split('\n')[0] || 'git status failed'}. `
      + 'Refusing to reset without that answer.'
    );
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

export async function factoryResetPlan(root, { packageVersion = null } = {}) {
  const repository = path.resolve(root);
  const localRuntime = path.join(gitDir(repository), LOCAL_RUNTIME_ROOT);
  await directoryState(path.join(repository, 'singularity'), 'Singularity control root');
  await directoryState(path.join(repository, '.singularity'), 'Legacy Singularity control root');
  await directoryState(localRuntime, 'Singularity local runtime root');
  // The token binds to this checkout at this commit, not just to its name. `RESET <name>` alone is
  // derivable from the directory you are standing in, so a token copied out of shell history — or
  // computed by an agent that never showed anybody the preview — matched a different clone of the
  // same repository just as happily as the one it was produced for.
  const revision = head(repository);
  const confirmation = `RESET ${path.basename(repository)} ${revision ? revision.slice(0, 7) : 'unborn'}`;
  return {
    schemaVersion: 1,
    operation: 'factory-reset',
    repository,
    branch: branch(repository),
    head: revision,
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

/**
 * Put back a directory this reset moved aside — and touch nothing it did not.
 *
 * The flag used to mean "the directory existed", which is not the same question. Anything thrown
 * before the rename left it false while the directory was still sitting in the repository, and the
 * unconditional `rm` below then deleted a control root that had never been copied anywhere. The
 * engine's own `loadDefinition` throws on an incomplete install — which is precisely the state
 * somebody runs a factory reset to repair — so the command most likely to hit this was the command
 * people ran to fix things.
 *
 * Now the flag means "this reset has the only other copy", and rollback is the only caller that can
 * remove the live path.
 */
async function restoreDirectory(current, backup, movedToBackup) {
  if (!movedToBackup) return;
  await rm(current, { recursive: true, force: true });
  await rename(backup, current);
}

/**
 * @param fault test seam for crash-point injection, matching the publication kernel's. Rollback is
 *   the whole point of this command and it is unreachable from a CLI test without one.
 */
export async function factoryResetRepository(root, {
  confirmation,
  packageVersion = null,
  allowDirty = false,
  fault = null
} = {}) {
  const plan = await factoryResetPlan(root, { packageVersion });
  if (confirmation !== plan.confirmation) {
    throw new SingularityFlowError(
      `Factory reset requires exact confirmation '${plan.confirmation}'. Run with --dry-run first, then pass --confirm ${JSON.stringify(plan.confirmation)}.`
    );
  }
  // Refused rather than warned about. These paths were computed, printed after the reset had
  // already discarded them, and never checked — and "Git history is the recovery path" is exactly
  // the claim that does not hold for them.
  //
  // Scoped to the control roots, which are the trees this command deletes outright. `.github/agents`
  // is in the reported set because a customised packaged agent is overwritten, but a freshly
  // initialised repository has that directory untracked with the packaged content already in it,
  // and refusing there would block the reset on files identical to what it is about to write.
  const discarded = plan.uncommittedResetPaths.filter((entry) =>
    CONTROL_ROOTS.some((control) => entry.slice(3).startsWith(`${control}/`) || entry.slice(3) === control));
  if (!allowDirty && discarded.length) {
    throw new SingularityFlowError(
      'Factory reset would discard uncommitted changes that Git cannot recover:\n'
      + discarded.map((item) => `  ${item}`).join('\n')
      + '\nCommit or stash them, or pass --allow-dirty to discard them deliberately.'
    );
  }

  const repository = plan.repository;
  // Inside .git, not inside the working tree. While the reset runs, this directory holds the only
  // other copy of the user's configuration — and in the working tree it was untracked content that
  // no .gitignore covered, so `git clean -fdx`, the obvious thing to run after a failed reset,
  // destroyed exactly the copy the failure made precious. Kept out of the local runtime root
  // because a successful reset deletes that.
  const staging = await mkdtemp(path.join(gitDir(repository), 'sflow-factory-reset-'));
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
  // "Moved", not "existed": the only thing rollback may act on is what this reset actually took.
  let controlMoved = false;
  let legacyMoved = false;
  const agentBackups = [];
  let installedAgents = [];
  let completed = false;
  let restoreFailed = false;

  try {
    await mkdir(fresh, { recursive: true });
    await initializeDefinition(fresh);
    await loadDefinition(fresh);
    installedAgents = await regularFiles(freshAgents);
    await mkdir(backup, { recursive: true });
    if (fault) await fault('after-fresh-install');

    const controlExisted = (await directoryState(control, 'Singularity control root')).exists;
    const legacyExisted = (await directoryState(legacy, 'Legacy Singularity control root')).exists;
    if (controlExisted) { await rename(control, backupControl); controlMoved = true; }
    if (legacyExisted) { await rename(legacy, backupLegacy); legacyMoved = true; }
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
    // Rollback failures were swallowed and the backup was then deleted regardless, so a restore
    // that did not happen looked exactly like one that did. They are collected instead: if any of
    // them failed, the backup is the only remaining copy and it is kept and named.
    const failures = [];
    const attempt = async (label, action) => {
      try { await action(); } catch (failure) { failures.push(`${label}: ${failure.message}`); }
    };
    await attempt('singularity/', () => restoreDirectory(control, backupControl, controlMoved));
    await attempt('.singularity/', () => restoreDirectory(legacy, backupLegacy, legacyMoved));
    for (const record of agentBackups.reverse()) {
      const target = path.join(targetAgents, record.relative);
      await attempt(path.posix.join('.github/agents', record.relative), async () => {
        if (!record.existed) return rm(target, { force: true });
        await mkdir(path.dirname(target), { recursive: true });
        return cp(path.join(backupAgents, record.relative), target, { force: true });
      });
    }
    if (failures.length) {
      restoreFailed = true;
      throw new SingularityFlowError(
        `Factory reset failed and could not be fully undone: ${failures.join('; ')}. `
        + `Your previous configuration is still in ${staging}; move it back by hand before rerunning. `
        + `The original failure was: ${error.message}`
      );
    }
    throw error;
  } finally {
    // Once the replacement validates, the backup is deliberately destroyed: Git history is the
    // recovery path and a factory reset must not leave a second local state tree behind. The one
    // exception is a rollback that did not fully succeed — then this directory holds the only copy
    // of the user's configuration, and deleting it is the last thing that should happen.
    if (!restoreFailed) await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Preview the deliberately broader local reset without treating registered workspace clones as
 * disposable. The registry is local convenience state; the clones contain application source and
 * therefore remain outside the deletion boundary even for RESET ALL.
 */
export async function factoryResetAllPlan(root, {
  packageVersion = null,
  localStateRoot = machineStateRoot()
} = {}) {
  const repository = await factoryResetPlan(root, { packageVersion });
  await directoryState(localStateRoot, 'Singularity machine-local state root');
  return {
    ...repository,
    operation: 'factory-reset-all',
    confirmation: RESET_ALL_CONFIRMATION,
    localStateRoot,
    remove: [
      ...repository.remove,
      `${localStateRoot} (saved workspace registry, active selection, lead-repository registry, and CLI telemetry setup)`
    ],
    preserve: [
      ...repository.preserve.filter((item) => item !== 'the global workspace registry and workspace clones'),
      'physical workspace directories and repository clones; only their local registrations are removed',
      'VS Code SecretStorage credentials; reset Jira or Teams credentials separately in VS Code'
    ]
  };
}

/** Reset repository-owned state and the machine-local registry as one recoverable operation. */
export async function factoryResetAll(root, {
  confirmation,
  packageVersion = null,
  localStateRoot = machineStateRoot(),
  fault = null
} = {}) {
  const plan = await factoryResetAllPlan(root, { packageVersion, localStateRoot });
  if (confirmation !== RESET_ALL_CONFIRMATION) {
    throw new SingularityFlowError(
      `Reset all requires --yes (confirmation '${RESET_ALL_CONFIRMATION}'). Run 'sflow reset-all' to preview its exact scope.`
    );
  }

  // Move the machine state aside first. If the repository reset fails, restore it, so an attempted
  // repair cannot strand the user with neither their old repository state nor workspace registry.
  const machineParent = path.dirname(localStateRoot);
  await mkdir(machineParent, { recursive: true });
  const staging = await mkdtemp(path.join(machineParent, '.sflow-reset-all-'));
  const machineBackup = path.join(staging, 'machine-state');
  const machineState = await directoryState(localStateRoot, 'Singularity machine-local state root');
  let machineMoved = false;
  try {
    if (machineState.exists) {
      await rename(localStateRoot, machineBackup);
      machineMoved = true;
    }
    if (fault) await fault('after-machine-state-move');
    const repository = await factoryResetRepository(root, {
      confirmation: (await factoryResetPlan(root, { packageVersion })).confirmation,
      packageVersion,
      allowDirty: true,
      fault: fault ? (stage) => fault(`repository:${stage}`) : null
    });
    await rm(staging, { recursive: true, force: true });
    return {
      ...plan,
      completed: true,
      installedAgents: repository.installedAgents,
      next: repository.next
    };
  } catch (error) {
    if (machineMoved) {
      await rm(localStateRoot, { recursive: true, force: true });
      await rename(machineBackup, localStateRoot);
    }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
