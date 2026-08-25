import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const cli = path.resolve('bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Worktree Story Tester'
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function repository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-worktree-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repository');
  await mkdir(root);
  run('git', ['init', '-q', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Worktree Story Tester'], root);
  run('git', ['config', 'user.email', 'worktree-story@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# isolated Story test\n');
  run(process.execPath, [cli, 'init'], root);
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionFile, YAML.stringify(definition));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-q', '-m', 'initialize'], root);
  const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', '-q', '-b', 'main', remote], base);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-q', '-u', 'origin', 'main'], root);
  return { base, root };
}

function git(root, args) {
  return run('git', args, root).stdout.trim();
}

test('a dirty prior checkout cannot block a new Story and is never mutated', async (t) => {
  const { root } = await repository(t);
  run('git', ['switch', '-q', '-c', 'CANCELLED-PRIOR'], root);
  await writeFile(path.join(root, 'unfinished-prior-story.txt'), 'keep this exact local work\n');
  const beforeHead = git(root, ['rev-parse', 'HEAD']);

  const started = run(process.execPath, [cli,
    'start', 'ISO-STORY-1', '--json', '--from-branch', 'main', '--work-type', 'feature',
    '--title', 'Start independently', '--description', 'Do not disturb the prior checkout.'
  ], root);
  const result = JSON.parse(started.stdout);
  const worktree = result.data.repositoryPath;

  assert.notEqual(path.resolve(worktree), path.resolve(root));
  assert.equal(git(root, ['branch', '--show-current']), 'CANCELLED-PRIOR');
  assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead);
  assert.match(git(root, ['status', '--porcelain']), /unfinished-prior-story\.txt/);
  assert.equal(await readFile(path.join(root, 'unfinished-prior-story.txt'), 'utf8'), 'keep this exact local work\n');
  assert.equal(git(worktree, ['branch', '--show-current']), 'ISO-STORY-1');
  assert.equal(JSON.parse(await readFile(path.join(
    worktree, 'singularity/work-items/ISO-STORY-1/workflow.json'
  ), 'utf8')).workItem.id, 'ISO-STORY-1');
  assert.equal(result.data.worktree.isolated, true);
});

test('session attach reuses the managed Story worktree instead of switching its launch clone', async (t) => {
  const { root } = await repository(t);
  const started = run(process.execPath, [cli,
    'start', 'ISO-ATTACH-1', '--isolated-worktree', '--json', '--from-branch', 'main',
    '--work-type', 'feature', '--title', 'Attach independently',
    '--description', 'Reuse the exact managed Story checkout without disturbing the launch clone.'
  ], root);
  const worktree = JSON.parse(started.stdout).data.repositoryPath;
  run('git', ['push', '-q', '-u', 'origin', 'ISO-ATTACH-1'], worktree);
  await writeFile(path.join(root, 'unrelated-launch-work.txt'), 'must remain in the launch checkout\n');

  const attached = run(process.execPath, [cli, 'session', 'attach', 'ISO-ATTACH-1', '--json'], root);
  const result = JSON.parse(attached.stdout);

  assert.equal(path.resolve(result.repositoryPath), path.resolve(worktree));
  assert.equal(await realpath(result.sourceRepositoryPath), await realpath(root));
  assert.equal(result.resolvedFrom, 'managed-story-worktree');
  assert.equal(result.materialization, 'reused-managed-story-worktree');
  assert.equal(git(root, ['branch', '--show-current']), 'main');
  assert.match(git(root, ['status', '--porcelain']), /unrelated-launch-work\.txt/);
  assert.equal(git(worktree, ['branch', '--show-current']), 'ISO-ATTACH-1');
  const status = JSON.parse(run(process.execPath, [cli, 'session', 'status', '--json'], worktree).stdout);
  assert.equal(status.workId, 'ISO-ATTACH-1');
  assert.equal(status.ready, true);
});

test('a failed isolated start removes its disposable checkout and branch', async (t) => {
  const { root } = await repository(t);
  await writeFile(path.join(root, 'unfinished-prior-story.txt'), 'still mine\n');
  const before = git(root, ['worktree', 'list', '--porcelain']);
  const failed = run(process.execPath, [cli,
    'start', 'ISO-FAIL-1', '--json', '--from-branch', 'main', '--work-type', 'does-not-exist',
    '--title', 'Fail safely', '--description', 'Exercise rollback.'
  ], root, { allowFailure: true });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Unknown workflow template/);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']), before);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/ISO-FAIL-1'], root, {
    allowFailure: true
  }).status, 1);
  assert.equal(git(root, ['branch', '--show-current']), 'main');
  assert.equal(await readFile(path.join(root, 'unfinished-prior-story.txt'), 'utf8'), 'still mine\n');
  const expected = path.join(path.dirname(root), '.singularity-flow', 'story-worktrees');
  await access(expected).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
});
