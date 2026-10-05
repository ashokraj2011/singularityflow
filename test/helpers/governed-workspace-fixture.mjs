/**
 * A sandboxed machine: a governed repository selected as the active workspace, optionally with a
 * started Story. Every machine-level store points into one temporary directory, so the real
 * `~/.singularity-flow` is never read or written (see test/machine-state-isolation.test.mjs).
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { removeTemporaryTree } from '../../src/util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

export function sandboxEnvironment(machine, extra = {}) {
  const home = path.join(machine, 'home');
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Contract Tester',
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(home, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(home, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(home, 'leads.json'),
    SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(home, 'journal'),
    SINGULARITY_FLOW_REPOSITORY_CATALOG: path.join(home, 'repository-catalog'),
    ...extra
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'SINGULARITY_FLOW_WORKSPACE_ROOT']) delete env[key];
  return env;
}

function checked(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result;
}

/** A blank machine: no workspace, no repository, an empty working directory. */
export async function blankMachineFixture() {
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-intellij-blank-'));
  const cwd = path.join(machine, 'empty');
  await mkdir(path.join(machine, 'home'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { machine, cwd, env: sandboxEnvironment(machine), cleanup: () => removeTemporaryTree(machine) };
}

/**
 * A governed repository with a bare remote, adopted as workspace `payments` and selected.
 * With `storyId`, a Story is started from `main`, so home has active work.
 */
export async function governedWorkspaceFixture({
  storyId = null, title = 'Fix the login error', workType = 'quick-fix'
} = {}) {
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-intellij-workspace-'));
  await mkdir(path.join(machine, 'home'), { recursive: true });
  const env = sandboxEnvironment(machine);
  const run = (command, args, cwd, label = `${command} ${args.join(' ')}`) =>
    checked(spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 }), label);
  const sflow = (args, cwd) => run(process.execPath, [CLI, ...args], cwd, `sflow ${args.join(' ')}`);

  const repository = path.join(machine, 'payments');
  await mkdir(repository, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], repository);
  run('git', ['config', 'user.name', 'Contract Tester'], repository);
  run('git', ['config', 'user.email', 'contract@example.com'], repository);
  await writeFile(path.join(repository, 'README.md'), '# payments\n');
  sflow(['init'], repository);
  const workflowFile = path.join(repository, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.git.publish = 'off';
  workflow.worldModel.grounding = 'off';
  await writeFile(workflowFile, YAML.stringify(workflow));
  run('git', ['add', '-A'], repository);
  run('git', ['commit', '-q', '-m', 'initialize'], repository);
  const remote = path.join(machine, 'payments.git');
  run('git', ['init', '-q', '--bare', '-b', 'main', remote], repository);
  run('git', ['remote', 'add', 'origin', remote], repository);
  run('git', ['push', '-q', '-u', 'origin', 'main'], repository);

  // Register and select it the way a developer does, so home reads a real registry entry.
  const workspaceBase = path.join(machine, 'workspaces');
  sflow(['workspace', 'adopt', repository, '--id', 'payments', '--base', workspaceBase, '--confirm', 'payments', '--json'], machine);
  sflow(['workspace', 'use', 'payments', '--json'], machine);

  if (storyId) {
    sflow(['start', storyId, '--from-branch', 'main', '--title', title, '--work-type', workType, '--json'], repository);
  }
  return { machine, repository, env, cleanup: () => removeTemporaryTree(machine) };
}

/**
 * Run `sflow home --json` exactly as the IntelliJ client does: `node <entry> home --json`, with
 * NO_COLOR and SINGULARITY_FLOW_NO_NETWORK set, from the project's Git root.
 */
export function homeAsIntellijClient({ cwd, env, workspace = null }) {
  const args = [CLI, 'home', '--json', ...(workspace ? ['--workspace', workspace] : [])];
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...env, NO_COLOR: '1', SINGULARITY_FLOW_NO_NETWORK: '1' },
    encoding: 'utf8',
    timeout: 120_000
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
