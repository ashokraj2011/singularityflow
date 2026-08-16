import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Story Publisher'
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const git = (root, ...args) => run('git', args, root);
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);

async function repository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-publication-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'checkout');
  await mkdir(root);
  git(base, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Story Publisher');
  git(root, 'config', 'user.email', 'story.publisher@example.com');
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'README.md'), '# Story publication\n');
  flow(root, ['init']);
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.worldModel.grounding = 'off';
  await writeFile(definitionFile, YAML.stringify(definition));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initialize governed repository');
  git(root, 'push', '-u', 'origin', 'main');

  git(root, 'switch', '-c', 'release/24.3');
  await writeFile(path.join(root, 'release.txt'), 'release-only base\n');
  git(root, 'add', 'release.txt');
  git(root, 'commit', '-m', 'Prepare release base');
  git(root, 'push', '-u', 'origin', 'release/24.3');
  git(root, 'switch', 'main');
  return { base, root, remote };
}

function start(root, id, extra = []) {
  return flow(root, [
    'start', id, '--json', '--from-branch', 'release/24.3',
    '--work-type', 'feature', '--title', 'Explicit Story branch',
    '--description', 'Prove exact base and publication refs.', ...extra
  ]);
}

test('Story start cuts from the selected remote base and publishes only its own branch', async () => {
  const { root } = await repository();
  const baseBefore = git(root, 'ls-remote', 'origin', 'refs/heads/release/24.3').stdout.split(/\s+/)[0];

  const result = JSON.parse(start(root, 'STORY-42').stdout);

  const localHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const remoteStory = git(root, 'ls-remote', 'origin', 'refs/heads/STORY-42').stdout.split(/\s+/)[0];
  const baseAfter = git(root, 'ls-remote', 'origin', 'refs/heads/release/24.3').stdout.split(/\s+/)[0];
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'STORY-42');
  assert.equal(remoteStory, localHead, 'the governed Story commit is the published Story ref');
  assert.equal(baseAfter, baseBefore, 'the selected base ref was not moved');
  assert.equal(git(root, 'merge-base', '--is-ancestor', baseBefore, localHead).status, 0);
  assert.equal(result.data.base.branch, 'release/24.3');
  assert.equal(result.data.base.commit, baseBefore);
  assert.deepEqual(result.data.publication, {
    remote: 'origin', branch: 'STORY-42', ref: 'refs/heads/STORY-42',
    pushed: true, commit: localHead
  });
  const workflow = JSON.parse(await readFile(
    path.join(root, 'singularity/work-items/STORY-42/workflow.json'), 'utf8'
  ));
  assert.equal(workflow.workItem.baseBranch, 'release/24.3');
  assert.equal(workflow.workItem.baseCommit, baseBefore);
  assert.equal(workflow.workItem.baseRemote, 'origin');
});

test('starting an existing durable Story routes to Resume without asking for another base', async () => {
  const { root } = await repository();
  start(root, 'STORY-RESUME');
  git(root, 'switch', 'main');

  const resumed = flow(root, ['start', 'STORY-RESUME']);

  assert.equal(resumed.status, 0);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'STORY-RESUME');
  assert.match(resumed.stdout, /STORY-RESUME/);
  assert.doesNotMatch(resumed.stderr, /--from-branch/);
});

test('a materialized Epic Story uses its pinned parent branch and commit as read-only base evidence', async () => {
  const { root } = await repository();
  const baseCommit = git(root, 'rev-parse', 'origin/release/24.3').stdout.trim();
  git(root, 'switch', '-c', 'STORY-SEEDED', 'origin/release/24.3');
  const seedDirectory = path.join(root, 'singularity/seeds');
  await mkdir(seedDirectory, { recursive: true });
  await writeFile(path.join(seedDirectory, 'STORY-SEEDED.yml'), YAML.stringify({
    version: 1,
    initiative: { id: 'EPIC-42' },
    story: {
      id: 'STORY-SEEDED',
      workId: 'STORY-SEEDED',
      title: 'Materialized Story',
      description: 'Use the exact parent selected during Epic materialization.',
      acceptanceCriteria: ['The pinned base is preserved.'],
      suggestedWorkType: 'feature',
      parentBranch: 'release/24.3',
      baseCommit
    }
  }));
  git(root, 'add', 'singularity/seeds/STORY-SEEDED.yml');
  git(root, 'commit', '-m', '[EPIC-42][story:STORY-SEEDED][seed] Link initiative');
  git(root, 'push', '-u', 'origin', 'HEAD:refs/heads/STORY-SEEDED');
  git(root, 'switch', 'main');
  git(root, 'branch', '-D', 'STORY-SEEDED');

  const result = JSON.parse(flow(root, ['start', 'STORY-SEEDED', '--json']).stdout);
  const workflow = JSON.parse(await readFile(
    path.join(root, 'singularity/work-items/STORY-SEEDED/workflow.json'), 'utf8'
  ));

  assert.equal(result.data.base.branch, 'release/24.3');
  assert.equal(result.data.base.commit, baseCommit);
  assert.equal(workflow.workItem.baseBranch, 'release/24.3');
  assert.equal(workflow.workItem.baseCommit, baseCommit);
  assert.equal(result.data.publication.ref, 'refs/heads/STORY-SEEDED');
  assert.equal(result.data.publication.pushed, true);
});

test('non-interactive Story start requires an explicit base before mutation', async () => {
  const { root } = await repository();
  const originalHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const refused = flow(root, [
    'start', 'STORY-NO-BASE', '--json', '--work-type', 'feature',
    '--title', 'Missing base', '--description', 'Must refuse.'
  ], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--from-branch/);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), originalHead);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/STORY-NO-BASE'], root,
    { allowFailure: true }).status, 1);
});

test('remote publication preflight failure creates no branch, Story state, or session change', async () => {
  const { root } = await repository();
  git(root, 'config', 'remote.origin.receivepack', '/usr/bin/false');
  const originalHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const result = flow(root, [
    'start', 'STORY-READ-ONLY', '--json', '--from-branch', 'release/24.3',
    '--work-type', 'feature', '--title', 'Read-only remote',
    '--description', 'Preflight must refuse before checkout.'
  ], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot publish the new Story branch/);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), originalHead);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/STORY-READ-ONLY'], root,
    { allowFailure: true }).status, 1);
  await assert.rejects(readFile(path.join(root, 'singularity/work-items/STORY-READ-ONLY/workflow.json')), /ENOENT/);
});

test('a post-preflight push rejection retains the commit and sync publishes it later', async () => {
  const { root, remote } = await repository();
  const hook = path.join(remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\necho rejected-after-dry-run >&2\nexit 1\n');
  await chmod(hook, 0o755);

  const failed = flow(root, [
    'start', 'STORY-RACE', '--json', '--from-branch', 'release/24.3',
    '--work-type', 'feature', '--title', 'Publication race',
    '--description', 'Retain an exact pending publication.'
  ], { allowFailure: true });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /retained locally but push failed/);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'STORY-RACE');
  const pending = path.join(root, '.git/singularity-flow/pending-publication/story--STORY-RACE.json');
  assert.match(await readFile(pending, 'utf8'), /refs?\/heads\/STORY-RACE|"branch": "STORY-RACE"/);

  await rm(hook);
  flow(root, ['sync']);
  const localHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const remoteHead = git(root, 'ls-remote', 'origin', 'refs/heads/STORY-RACE').stdout.split(/\s+/)[0];
  assert.equal(remoteHead, localHead);
  await assert.rejects(readFile(pending), /ENOENT/);
});
