import { initializeDefinition } from '../src/config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { phasePromptExecutionContract } from '../src/worldmodel.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function isolatedMachineEnvironment(cwd, env = process.env) {
  const machineState = path.join(cwd, '.isolated-machine-state');
  return {
    ...env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineState, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineState, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineState, 'lead-registry.json'),
    SINGULARITY_FLOW_WMB_SHARED_CACHE: path.join(machineState, 'wmb-shared-cache')
  };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: isolatedMachineEnvironment(cwd)
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function result(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: isolatedMachineEnvironment(cwd, env) });
}

test('phase prompts bind deterministic convergence to its exact publication and clarification contract', () => {
  const phase = {
    id: 'convergence',
    generationPolicy: {
      requirement: 'required',
      defaultProducer: 'deterministic',
      allowedProducers: ['deterministic'],
      producer: 'deterministic',
      task: 'analyze'
    }
  };
  const workflow = {
    resolution: {
      phases: [{ id: 'convergence', clarification: { mode: 'off' } }]
    }
  };
  const definition = {
    phases: { convergence: { generation: phase.generationPolicy, clarification: { mode: 'required' } } }
  };

  const contract = phasePromptExecutionContract(definition, workflow, phase);
  assert.equal(contract.deterministicOnly, true);
  assert.deepEqual(contract.publication, {
    producer: 'deterministic',
    channel: 'kernel-generator',
    allowedProducers: ['deterministic'],
    command: 'singularity-flow phase publish convergence --authored deterministic --channel kernel-generator'
  });
  assert.equal(contract.clarification.mode, 'off');
  assert.equal(
    contract.command,
    'singularity-flow phase publish convergence --authored deterministic --channel kernel-generator'
  );
  const rendered = contract.lines.join('\n');
  assert.match(rendered, /Default publication producer: `deterministic`/);
  assert.match(rendered, /Allowed publication producers: `deterministic`/);
  assert.match(rendered, /Required publication channel: `kernel-generator`/);
  assert.match(rendered, /Clarification mode: `off`; do not ask phase clarification questions/);
  assert.match(rendered, /pinned mode overrides generic skill, agent, and template guidance/);
  assert.match(rendered, /Exact publication command: `singularity-flow phase publish convergence --authored deterministic --channel kernel-generator`/);
  assert.match(rendered, /do not author or edit the phase artifact with a model, governed agent, or human/i);
});

test('evidence-planning instructions follow ownership for custom agents/phases, not a built-in planner name', () => {
  const phase = { id: 'team-solution', generationPolicy: { requirement: 'required', producer: 'governed-agent', allowedProducers: ['governed-agent'] } };
  const workflow = { phases: { 'team-solution': phase }, resolution: { phases: [], plannedClaims: { owners: { 'team-build': phase.id } } } };
  assert.match(phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n'), /Fulfillment `evidence`/u);
  assert.match(phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n'), /actual `## Verification contracts` table/u);
  workflow.resolution.plannedClaims.owners = {};
  assert.doesNotMatch(phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n'), /Evidence planning/u);
});

test('wm cleanup removes a worktree whose recorded builder process is dead', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-cleanup-repo-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.email', 'wm@example.com'], root);
  run('git', ['config', 'user.name', 'World Model'], root);
  await writeFile(path.join(root, 'README.md'), '# cleanup\n');
  await initializeDefinition(root);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'init'], root);

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-world-model-'));
  const worktree = path.join(temporary, 'repository');
  await writeFile(path.join(temporary, 'singularity-flow-owner.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'analysis',
    pid: 999999,
    createdAt: new Date(0).toISOString(),
    repositoryGitDirectory: path.join(root, '.git')
  }));
  run('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], root);

  const cleanup = result(process.execPath, [bin, 'wm', 'cleanup', '--json'], root);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const report = JSON.parse(cleanup.stdout);
  assert.equal(report.removed.length, 1);
  assert.equal(path.basename(path.dirname(report.removed[0])), path.basename(temporary));
  assert.doesNotMatch(run('git', ['worktree', 'list', '--porcelain'], root), new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await assert.rejects(lstat(temporary), /ENOENT/);
});
