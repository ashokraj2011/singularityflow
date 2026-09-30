import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import { loadRepositoryTestBaseline } from '../src/initialization/runtime-readiness.mjs';
import { manualStorySource, startStory } from '../src/story-start.mjs';

const bin = path.resolve('bin/singularity-flow.mjs');

function command(program, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(program, args, {
    cwd, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Known Failure Reviewer'
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const git = (root, ...args) => command('git', args, root);
const flow = (root, args, options) => command(process.execPath, [bin, ...args], root, options);

test('CLI starts an isolated Story on an exact accepted failing baseline and publishes its evidence', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-risk-story-start-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'checkout');
  const remote = path.join(base, 'origin.git');
  await mkdir(root);
  git(base, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Known Failure Reviewer');
  git(root, 'config', 'user.email', 'known.failure@example.test');
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'README.md'), '# Existing app\n');
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/\n');
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'existing-failing-tests', version: '1.0.0', private: true,
    packageManager: 'npm@10.8.0', scripts: {
      test: 'node --test --test-reporter=tap test/existing.test.mjs'
    }
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'existing-failing-tests', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'existing-failing-tests', version: '1.0.0' } }
  }, null, 2)}\n`);
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'test', 'existing.test.mjs'), [
    "import test from 'node:test';",
    "test('known failure before Story coding', () => { throw new Error('existing failure'); });",
    ''
  ].join('\n'));
  flow(root, ['init']);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowFile, 'utf8'));
  definition.git.publish = 'off';
  definition.worldModel.grounding = 'off';
  definition.repositoryReadiness.requiredBeforeStory = true;
  definition.repositoryReadiness.dependencyHydration = 'required';
  definition.repositoryReadiness.build = 'off';
  definition.repositoryReadiness.structuredTests = 'required-for-code';
  definition.repositoryReadiness.applicationStart = 'off';
  await writeFile(workflowFile, YAML.stringify(definition));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initialize governed app with existing failing test');
  git(root, 'push', '-u', 'origin', 'main');

  const plan = JSON.parse(flow(root, [
    'precheck', '--run', '--scope', 'dependency-test', '--json'
  ]).stdout).data.plan;
  assert.equal(plan.status, 'ready');
  const failed = flow(root, [
    'precheck', '--run', '--scope', 'dependency-test',
    '--confirm-plan', plan.planId, '--json'
  ], { allowFailure: true });
  assert.notEqual(failed.status, 0);
  const loaded = await loadRepositoryTestBaseline(root, { scope: 'dependency-test' });
  assert.equal(loaded.baseline.status, 'failing-tests');
  const storyArgs = [
    'start', 'STORY-KNOWN-FAIL', '--json', '--from-branch', 'main',
    '--work-type', 'feature', '--title', 'Repair existing test in Story',
    '--description', 'Continue with one explicitly accepted pre-existing unit failure.'
  ];
  const withoutDecision = flow(root, storyArgs, { allowFailure: true });
  assert.notEqual(withoutDecision.status, 0, 'a failed baseline alone cannot start the Story');
  assert.equal(git(root, 'branch', '--list', 'STORY-KNOWN-FAIL').stdout.trim(), '');
  const accepted = flow(root, [
    'precheck', '--accept-test-risk', '--reason',
    'This unit case failed before coding and will be repaired during the Story.',
    '--confirm-baseline', loaded.baseline.baselineSha256,
    '--expires', new Date(Date.now() + 86_400_000).toISOString(), '--json'
  ]);
  assert.equal(JSON.parse(accepted.stdout).data.acceptance.status, 'accepted-known-failures');

  const started = flow(root, storyArgs);
  const result = JSON.parse(started.stdout);
  assert.ok(result.data, `Story result keys: ${Object.keys(result).join(', ')}`);
  assert.ok(result.data.readiness, `Story data keys: ${Object.keys(result.data).join(', ')}`);
  assert.equal(result.data.readiness.ready, true);
  assert.equal(result.data.readiness.status, 'ready-with-warnings');
  const storyRoot = result.data.repositoryPath ?? result.data.workspace?.repositoryPath
    ?? path.join(root, '.singularity-flow', 'story-worktrees', 'STORY-KNOWN-FAIL',
      'repos', path.basename(root));
  const document = JSON.parse(await readFile(path.join(storyRoot,
    'singularity/work-items/STORY-KNOWN-FAIL/context/repository-test-readiness.json'), 'utf8'));
  assert.equal(document.repositories[0].status, 'accepted-known-failures');
  assert.equal(document.repositories[0].testResults[0].counts.failed, 1);
  assert.equal(document.repositories[0].existingFailureDisposition,
    'accepted-pre-existing-test-failures');
  assert.equal(document.repositories[0].riskAcceptance.baselineSha256,
    loaded.baseline.baselineSha256);
  assert.equal(Object.hasOwn(document.repositories[0].riskAcceptance, 'reason'), false);
  assert.equal(git(root, 'status', '--porcelain').stdout.trim(), '');

  // The selected remote base can differ from the launch checkout. Its provisional acceptance
  // must survive that preview and be recomputed after the programmatic start checks out the base.
  git(root, 'switch', '-c', 'later-local');
  await writeFile(path.join(root, 'later-local.txt'), 'A separate local checkout.\n');
  git(root, 'add', 'later-local.txt');
  git(root, 'commit', '-m', 'Keep launch checkout separate from selected base');
  const desktop = await startStory(root, {
    id: 'STORY-KNOWN-DESKTOP',
    source: manualStorySource('STORY-KNOWN-DESKTOP', {
      title: 'Continue from accepted selected base'
    }),
    workType: 'feature', baseBranch: 'main'
  });
  assert.equal(desktop.readiness.ready, true);
  assert.equal(desktop.readiness.status, 'ready-with-warnings');
  const desktopDocument = JSON.parse(await readFile(path.join(root,
    'singularity/work-items/STORY-KNOWN-DESKTOP/context/repository-test-readiness.json'), 'utf8'));
  assert.equal(desktopDocument.repositories[0].status, 'accepted-known-failures');
  assert.equal(desktopDocument.repositories[0].riskAcceptance.baselineSha256,
    loaded.baseline.baselineSha256);
});
