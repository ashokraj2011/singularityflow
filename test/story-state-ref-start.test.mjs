// SSB M2 [SSB:REQ-002, 003, 006, 010]: with `story.storage: state-ref`, a new Story's records are created at its start
// on refs/singularity/state/<ID> and checked out at .sflow-state/; the Story branch gets none of them. Without the
// setting, Story start is today's, byte for byte (test/story-start.test.mjs runs unchanged).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { loadDefinition } from '../src/config.mjs';
import { manualStorySource, startStory } from '../src/story-start.mjs';
import { loadWorkflow } from '../src/story-workflow-read.mjs';
import { forgetStoryLayouts, storyLocation } from '../src/story-paths.mjs';
import { ensureConfigurationBranch } from '../src/configuration-branch.mjs';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'State Ref Tester' }
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t, { storage = 'state-ref', publish = 'off', configurationAuthority = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ssb-start-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(`${root}.git`, { recursive: true, force: true })]));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'State Ref Tester'], root);
  run('git', ['config', 'user.email', 'state-ref@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# State ref Stories\n');
  run(process.execPath, [path.resolve('bin/singularity-flow.mjs'), 'init'], root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = publish;
  definition.repositoryReadiness.requiredBeforeStory = false;
  if (storage) definition.story = { storage };
  await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  run('git', ['init', '--bare', '-b', 'main', `${root}.git`], root);
  run('git', ['remote', 'add', 'origin', `${root}.git`], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  if (configurationAuthority) await ensureConfigurationBranch(`${root}.git`);
  return root;
}

test.afterEach(() => forgetStoryLayouts());

test('story.storage: state-ref creates the Story\'s state ref and checkout at its start; the branch carries no record', async (t) => {
  const root = await repository(t);
  const base = run('git', ['rev-parse', 'HEAD'], root);
  const started = await startStory(root, { id: 'SSB-1', workType: 'feature', baseBranch: 'main',
    source: manualStorySource('SSB-1', { title: 'Records off the code branch' }) });
  assert.equal(started.storage.layout, 'state-ref');
  assert.equal(started.storage.ref, 'refs/singularity/state/SSB-1');
  assert.equal(started.storage.published, false);
  // The Story branch is the base: no SFlow commit, nothing in the pull request but code and documents.
  assert.equal(run('git', ['branch', '--show-current'], root), 'SSB-1');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root), base);
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all'], root), '');
  assert.equal(existsSync(path.join(root, 'singularity/work-items/SSB-1')), false);
  // The records are on the state ref, in the tree REQ-003 names, with no application history.
  const tree = run('git', ['ls-tree', '-r', '--name-only', 'refs/singularity/state/SSB-1'], root).split('\n');
  assert.ok(tree.includes('workflow.json'));
  assert.ok(tree.includes('STATUS.md'));
  assert.ok(tree.every((file) => !file.startsWith('singularity/work-items/')));
  assert.equal(spawnSync('git', ['merge-base', 'main', 'refs/singularity/state/SSB-1'], { cwd: root }).status, 1);
  assert.equal(run('git', ['rev-parse', 'refs/singularity/state/SSB-1'], root), started.storage.commit);
  // The checkout is the ref, detached and clean; its line is in the clone's exclude, never in .gitignore.
  assert.equal(run('git', ['rev-parse', 'HEAD'], path.join(root, '.sflow-state')), started.storage.commit);
  assert.equal(run('git', ['status', '--porcelain'], path.join(root, '.sflow-state')), '');
  assert.match(await readFile(path.join(root, '.git/info/exclude'), 'utf8'), /^\/\.sflow-state\/$/mu);
  assert.equal(existsSync(path.join(root, '.gitignore')) && /sflow-state/u.test(await readFile(path.join(root, '.gitignore'), 'utf8')), false);
  // The workflow records its layout for life [REQ-010], and reads back from the state checkout.
  const recorded = JSON.parse(await readFile(path.join(root, '.sflow-state/workflow.json'), 'utf8'));
  assert.deepEqual(recorded.resolution.story, { storage: 'state-ref' });
  forgetStoryLayouts();
  const definition = await loadDefinition(root);
  const workflow = await loadWorkflow(root, definition, 'SSB-1');
  assert.equal(workflow.workItem.id, 'SSB-1');
  assert.equal(storyLocation(root, definition, 'SSB-1').layout, 'state-ref');
  assert.equal(storyLocation(root, [workflow, definition], 'SSB-1').workflowFile, path.join(root, '.sflow-state/workflow.json'));
});

test('without the setting a new Story starts on today\'s layout: records on the branch, no state ref, no checkout', async (t) => {
  const root = await repository(t, { storage: null });
  const started = await startStory(root, { id: 'SSB-2', workType: 'feature', baseBranch: 'main',
    source: manualStorySource('SSB-2', { title: 'Today\'s layout' }) });
  assert.equal(started.storage, undefined);
  assert.equal(existsSync(path.join(root, 'singularity/work-items/SSB-2/workflow.json')), true);
  assert.equal(existsSync(path.join(root, '.sflow-state')), false);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/singularity/state/SSB-2'], { cwd: root }).status, 1);
  const recorded = JSON.parse(await readFile(path.join(root, 'singularity/work-items/SSB-2/workflow.json'), 'utf8'));
  assert.equal(Object.hasOwn(recorded.resolution, 'story'), false);
});

test('a refused state-ref Story start leaves no state ref, no checkout and no Story branch behind', async (t) => {
  const root = await repository(t);
  await assert.rejects(startStory(root, { id: 'SSB-3', workType: 'feature', baseBranch: 'main',
    source: manualStorySource('SSB-3', { title: 'Refused after its records were written' }),
    publicationFault: async (stage) => { if (stage === 'after-state-write') throw new Error('injected refusal'); } }),
  /injected refusal/u);
  assert.equal(run('git', ['branch', '--show-current'], root), 'main');
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/SSB-3'], { cwd: root }).status, 1);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/singularity/state/SSB-3'], { cwd: root }).status, 1);
  assert.equal(existsSync(path.join(root, '.sflow-state')), false);
  assert.doesNotMatch(run('git', ['worktree', 'list'], root), /\.sflow-state/u);
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all'], root), '');
  // The same ID starts cleanly afterwards.
  const started = await startStory(root, { id: 'SSB-3', workType: 'feature', baseBranch: 'main',
    source: manualStorySource('SSB-3', { title: 'Started the second time' }) });
  assert.equal(started.storage.layout, 'state-ref');
});

test('with approved configuration on sflow/config, the pinned copy is a record too: it lives in the state checkout', async (t) => {
  const root = await repository(t, { configurationAuthority: true });
  const started = await startStory(root, { id: 'SSB-4', workType: 'feature', baseBranch: 'main',
    source: manualStorySource('SSB-4', { title: 'Pinned configuration off the code branch' }) });
  assert.equal(started.storage.layout, 'state-ref');
  const tree = run('git', ['ls-tree', '-r', '--name-only', 'refs/singularity/state/SSB-4'], root).split('\n');
  assert.ok(tree.includes('configuration/singularity/workflow.yml'), tree.join('\n'));
  assert.ok(tree.includes('configuration/singularity/configuration-source.json'));
  // The code branch keeps its own files, unchanged by the pin; nothing is left to commit.
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all'], root), '');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root), run('git', ['rev-parse', 'main'], root));
  const location = storyLocation(root, {}, 'SSB-4');
  assert.equal(location.configurationSource.absolute, path.join(root, '.sflow-state/configuration/singularity/configuration-source.json'));
  assert.equal(existsSync(location.configurationSource.absolute), true);
});

test('the setting is checked: an unknown layout or key is refused when the configuration loads', async (t) => {
  const root = await repository(t, { storage: null });
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.story = { storage: 'elsewhere' };
  await writeFile(definitionPath, YAML.stringify(definition));
  await assert.rejects(loadDefinition(root), /story\.storage must be story-branch or state-ref/u);
  definition.story = { layout: 'state-ref' };
  await writeFile(definitionPath, YAML.stringify(definition));
  await assert.rejects(loadDefinition(root), /story\.layout is not a setting/u);
});
