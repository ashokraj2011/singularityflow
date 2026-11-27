// SSB M3 (c) [SSB:REQ-008; docs/plans/SSB-M3-PLAN.md §3 (c), §2.4]: a state-ref Story's records are never lost to a
// cleanup. A state checkout with records not committed is kept, and `sync <ID> --set-aside` keeps them in a commit on a
// ref of their own (no `git stash`); a state ref holding commits the remote has not got keeps the checkout and stops the
// workspace drop until `sync` publishes them; a process that dies during its state write is undone from its saved copy,
// so the next transition never commits what it left.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { run as runProcess } from '../src/util.mjs';
import { LIFECYCLE_EVENT } from '../src/lifecycle-event.mjs';
import { loadDefinition } from '../src/config.mjs';
import { manualStorySource, startStory } from '../src/story-start.mjs';
import { loadWorkflow } from '../src/story-workflow-read.mjs';
import { commitAndPublish } from '../src/story-publication-service.mjs';
import { forgetStoryLayouts } from '../src/story-paths.mjs';
import { assertStoryStatesKept, removeStateCheckout } from '../src/story-state-ref.mjs';
import { releaseStateCheckout } from '../src/story-worktree.mjs';
import { STORY_STATE_REF_PREVIEW } from '../src/work-item-location.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const git = (cwd, args) => runProcess('git', args, { cwd }).stdout.trim();
const env = () => ({ ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Retention Tester', [STORY_STATE_REF_PREVIEW]: '1' });

function sh(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: env() });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
const cli = (root, ...args) => sh(process.execPath, [CLI, ...args], root);

function preview(t) {
  const was = process.env[STORY_STATE_REF_PREVIEW];
  process.env[STORY_STATE_REF_PREVIEW] = '1';
  t.after(() => { if (was === undefined) delete process.env[STORY_STATE_REF_PREVIEW]; else process.env[STORY_STATE_REF_PREVIEW] = was; });
}

/** A repository with a bare remote and a state-ref Story started and published. */
async function startedStory(t, id) {
  preview(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ssb-retention-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(`${root}.git`, { recursive: true, force: true })]));
  sh('git', ['init', '-b', 'main'], root);
  git(root, ['config', 'user.name', 'Retention Tester']);
  git(root, ['config', 'user.email', 'retention@example.test']);
  await writeFile(path.join(root, 'README.md'), '# Kept records\n');
  cli(root, 'init');
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'required';
  definition.repositoryReadiness.requiredBeforeStory = false;
  definition.story = { storage: 'state-ref' };
  await writeFile(definitionPath, YAML.stringify(definition));
  sh('git', ['add', '.'], root);
  sh('git', ['commit', '-m', 'initialize'], root);
  sh('git', ['init', '--bare', '-b', 'main', `${root}.git`], root);
  sh('git', ['remote', 'add', 'origin', `${root}.git`], root);
  sh('git', ['push', '-u', 'origin', 'main'], root);
  await startStory(root, { id, workType: 'feature', baseBranch: 'main', source: manualStorySource(id, { title: 'Kept records' }) });
  return { root, remote: `${root}.git`, ref: `refs/singularity/state/${id}`, state: path.join(root, '.sflow-state') };
}

async function note(root, id, message, options = {}) {
  forgetStoryLayouts();
  const definition = await loadDefinition(root);
  const workflow = await loadWorkflow(root, definition, id);
  return commitAndPublish(root, definition, workflow, { type: LIFECYCLE_EVENT.BINDING }, `[${id}][state] ${message}`, [], options);
}

function refusal(action) {
  try { action(); } catch (error) { return error; }
  assert.fail('expected a refusal');
}

test('unfinished records keep the state checkout; sync --set-aside keeps them on a ref of their own, then it is removed', async (t) => {
  const id = 'SSB-R1';
  const { root, state } = await startedStory(t, id);
  await writeFile(path.join(state, 'context', 'unfinished.json'), '{"left":"by a command that did not finish"}\n');
  const refused = refusal(() => removeStateCheckout(root, { id }));
  assert.equal(refused.code, 'STORY_STATE_CHECKOUT_UNSAVED');
  assert.deepEqual(refused.details.nextAction.argv, ['sync', id, '--set-aside'], 'the way out is SFlow\'s, never git stash');
  assert.equal(await releaseStateCheckout(root), false);
  assert.ok(existsSync(path.join(state, 'context', 'unfinished.json')));

  const preview = JSON.parse(cli(root, 'sync', id, '--set-aside', '--json'));
  assert.equal(preview.kind, 'unfinished');
  assert.equal(preview.needed, true);
  assert.deepEqual(preview.nextAction.argv, ['sync', id, '--set-aside', '--confirm', preview.token]);
  assert.ok(existsSync(path.join(state, 'context', 'unfinished.json')), 'a preview changes nothing');
  const done = JSON.parse(cli(root, 'sync', id, '--set-aside', '--confirm', preview.token, '--json'));
  assert.equal(done.setAside, true);
  assert.match(done.aside, new RegExp(`^refs/singularity/state-aside/${id}/.+-unfinished$`, 'u'));
  assert.equal(git(root, ['show', `${done.aside}:context/unfinished.json`]), '{"left":"by a command that did not finish"}');
  assert.equal(git(state, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(git(root, ['stash', 'list']), '', 'nothing went to the stash');
  assert.equal(removeStateCheckout(root, { id }).removed, true);
});

test('state commits the remote has not got keep the checkout and stop the drop; sync publishes them, then both go', async (t) => {
  const id = 'SSB-R2';
  const { root, remote, ref } = await startedStory(t, id);
  await assert.rejects(note(root, id, 'kept here', { fault: async (stage) => { if (stage === 'after-commit') throw new Error('stopped before the push'); } }),
    /stopped before the push/u);
  assert.notEqual(git(remote, ['rev-parse', ref]), git(root, ['rev-parse', ref]), 'the remote lacks the commit');
  const refused = refusal(() => removeStateCheckout(root, { id }));
  assert.equal(refused.code, 'STORY_STATE_UNPUBLISHED', refused.message);
  assert.deepEqual(refused.details.nextAction.argv, ['sync', id]);
  assert.equal(await releaseStateCheckout(root), false, 'cleanup and retention keep it');
  await assert.rejects(assertStoryStatesKept(root), (error) => error.code === 'STORY_STATE_UNPUBLISHED'
    && error.details.nextAction.argv.join(' ') === `sync ${id}`);

  cli(root, 'sync', id);
  assert.equal(git(remote, ['rev-parse', ref]), git(root, ['rev-parse', ref]));
  assert.deepEqual(await assertStoryStatesKept(root), { checked: 1 });
  assert.equal(removeStateCheckout(root, { id }).removed, true);
});

test('a process that dies during its state write is undone from its saved copy; the next transition commits none of it', async (t) => {
  const id = 'SSB-R3';
  const { root, remote, ref, state } = await startedStory(t, id);
  const before = git(root, ['rev-parse', ref]);
  const left = path.join(state, 'context', 'left-by-a-dying-command.json');
  // A transition in a process of its own, which exits in the middle of its state write: no undo runs.
  const module = (name) => JSON.stringify(pathToFileURL(path.join(ROOT, 'src', name)).href);
  const script = `
    import { writeFileSync } from 'node:fs';
    const { loadDefinition } = await import(${module('config.mjs')});
    const { loadWorkflow } = await import(${module('story-workflow-read.mjs')});
    const { commitAndPublish } = await import(${module('story-publication-service.mjs')});
    const { LIFECYCLE_EVENT } = await import(${module('lifecycle-event.mjs')});
    const root = process.cwd();
    const definition = await loadDefinition(root);
    const workflow = await loadWorkflow(root, definition, ${JSON.stringify(id)});
    await commitAndPublish(root, definition, workflow, { type: LIFECYCLE_EVENT.BINDING }, '[${id}][state] dies', [], {
      fault: async (stage) => { if (stage === 'after-state-write') { writeFileSync(${JSON.stringify(left)}, '{}\\n'); process.exit(9); } }
    });`;
  const died = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', env: env() });
  assert.equal(died.status, 9, `${died.stdout}\n${died.stderr}`);
  assert.ok(existsSync(left), 'the dead process left its files');
  assert.equal(git(root, ['rev-parse', ref]), before, 'and moved no ref');

  const next = await note(root, id, 'next');
  assert.equal(next.pushed, true);
  const files = git(root, ['ls-tree', '-r', '--name-only', ref]).split('\n');
  assert.ok(!files.includes('context/left-by-a-dying-command.json'), 'the next transition did not commit what the dead one left');
  assert.ok(!existsSync(left));
  assert.equal(git(remote, ['rev-parse', ref]), next.sha);
  assert.equal(git(state, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(git(root, ['rev-list', '--count', `${before}..${ref}`]), '1', 'one state commit: the next transition\'s');
});
