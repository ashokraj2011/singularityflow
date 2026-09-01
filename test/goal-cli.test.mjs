import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function runGit(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
}

function cli(args, env, cwd) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function environment() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-goal-cli-'));
  const source = path.join(base, 'source.git');
  const seed = path.join(base, 'seed');
  runGit(base, 'init', '--bare', '-q', source);
  runGit(base, 'init', '-q', '-b', 'main', seed);
  runGit(seed, 'config', 'user.name', 'Goal CLI Tester');
  runGit(seed, 'config', 'user.email', 'goal-cli@example.com');
  await writeFile(path.join(seed, 'README.md'), '# goal fixture\n');
  runGit(seed, 'add', 'README.md');
  runGit(seed, 'commit', '-qm', 'fixture');
  runGit(seed, 'push', '-q', source, 'main');
  return {
    base,
    source,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Goal CLI Tester',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'registry.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json')
    }
  };
}

test('goal CLI uses durable active-workspace state from outside a repository', async () => {
  const { base, source, env } = await environment();
  const workspaceBase = path.join(base, 'workspaces');
  cli([
    'workspace', 'create', '--local', '--id', 'goal-team', '--name', 'Goal team',
    '--base', workspaceBase, '--lead', 'app', '--repository', `app=${source}`, '--confirm', 'goal-team'
  ], env, base);
  cli(['workspace', 'use', 'goal-team'], env, base);

  const created = JSON.parse(cli([
    'goal', 'create', 'Make checkout resilient', '--success',
    'Checkout completes after one timeout retry', '--json'
  ], env, base));
  assert.equal(created.operation.id, 'goal.create');
  assert.equal(created.subject.kind, 'goal');
  assert.equal(created.data.goal.statement, 'Make checkout resilient');
  assert.equal(created.data.authority, 'personal-advisory');

  const listed = JSON.parse(cli(['goal', 'list', '--json'], env, base));
  assert.equal(listed.data.goals.length, 1);
  assert.equal(listed.data.activeGoalId, created.data.goal.id);
  assert.equal(listed.effects.stateChanged, false);

  const governed = JSON.parse(cli([
    'goal', 'govern', created.data.goal.id, '--json'
  ], env, base));
  assert.equal(governed.operation.id, 'goal.govern');
  assert.match(governed.data.goal.id, /^GEX-/);
  assert.equal(governed.data.authority, 'governed-execution');
  assert.equal(governed.data.contract.source.personalGoalId, created.data.goal.id);
  const governedList = JSON.parse(cli(['goal', 'list', '--mode', 'governed', '--json'], env, base));
  assert.equal(governedList.data.goals.length, 1);
  const inspected = JSON.parse(cli(['goal', 'inspect', governed.data.goal.id, '--json'], env, base));
  assert.equal(inspected.data.contract.contractSha256, governed.data.contract.contractSha256);

  const completed = JSON.parse(cli([
    'goal', 'complete', created.data.goal.id, '--confirm', created.data.goal.id, '--json'
  ], env, base));
  assert.equal(completed.data.goal.status, 'achieved');
  assert.equal(completed.data.activeGoalId, null);
});

test('goal sync reports a killed pre-commit creation as recovered instead of not found', async () => {
  const { base, source, env } = await environment();
  const workspaceBase = path.join(base, 'workspaces');
  cli([
    'workspace', 'create', '--local', '--id', 'goal-recovery', '--name', 'Goal recovery',
    '--base', workspaceBase, '--lead', 'app', '--repository', `app=${source}`,
    '--confirm', 'goal-recovery'
  ], env, base);
  cli(['workspace', 'use', 'goal-recovery'], env, base);

  const workspacePath = path.join(workspaceBase, 'goal-recovery');
  const workspace = JSON.parse(await readFile(path.join(workspacePath, 'workspace.json'), 'utf8'));
  const repository = path.join(workspacePath, 'repos', 'app');
  const id = `GEX-${'0'.repeat(26)}`;
  const control = path.join(base, 'killed-goal-create.json');
  await writeFile(control, `${JSON.stringify({
    context: {
      workspace,
      selected: { repositoryId: 'app', storyId: null },
      leadRepositoryPath: repository,
      repositoryPath: repository
    },
    personal: {
      id: 'GOL-20260901-001', statement: 'Recover a bounded Goal creation',
      successCriteria: ['The interrupted creation leaves no unpublished Goal authority'],
      links: []
    },
    id,
    config: { git: { remote: 'origin', publish: 'required' } },
    now: '2026-09-01T00:00:00.000Z',
    faultPoint: 'after-state-write'
  }, null, 2)}\n`);
  const killed = spawnSync(process.execPath, [
    path.join(packageRoot, 'test', 'fixtures', 'governed-goal-crash-child.mjs'), control
  ], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr || killed.stdout);

  const recovered = JSON.parse(cli(['goal', 'sync', id, '--json'], env, base));
  assert.equal(recovered.outcome.messageId, 'goal.precommit-recovered');
  assert.equal(recovered.subject.id, id);
  assert.equal(recovered.data.publication.recoveredPrepared, true);
  assert.equal(recovered.data.publication.commit, null);
});
