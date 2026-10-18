import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyStoryBranchNaming, assertStoryBranchNaming, renderStoryBranchName, STORY_BRANCH_DEFAULT_PATTERN
} from '../src/story-branch-name.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
};

async function repository(t, workflowYaml) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-branch-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Branch Namer');
  git(root, 'config', 'user.email', 'branch.namer@example.test');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), workflowYaml);
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

test('the branch naming setting accepts a pattern with {id} and names what is wrong otherwise', () => {
  assert.doesNotThrow(() => assertStoryBranchNaming(undefined));
  assert.doesNotThrow(() => assertStoryBranchNaming({ pattern: 'feature/{id}-{title}' }));
  assert.doesNotThrow(() => assertStoryBranchNaming({ pattern: STORY_BRANCH_DEFAULT_PATTERN }));
  assert.throws(() => assertStoryBranchNaming({ pattern: 'feature/{title}' }), /must contain \{id\}/u);
  assert.throws(() => assertStoryBranchNaming({ pattern: 'users/{user}/{id}' }), /uses \{user\}\. The placeholders are \{id\} and \{title\}/u);
  assert.throws(() => assertStoryBranchNaming({ pattern: 'feature/{id}', prefix: 'x' }), /git\.branchNaming\.prefix is not a setting/u);
  assert.throws(() => assertStoryBranchNaming({ pattern: '' }), /non-empty string/u);
  assert.throws(() => assertStoryBranchNaming('feature/{id}'), /must be a mapping/u);
});

test('a pattern names the branch from the ID and a short title slug', () => {
  const title = "Card charges fail with 'card token missing'";
  assert.equal(renderStoryBranchName('feature/{id}-{title}', { id: 'INC-7', title }), 'feature/INC-7-card-charges-fail-with-card-token');
  assert.equal(renderStoryBranchName('feature/{id}', { id: 'INC-7', title }), 'feature/INC-7');
  assert.equal(renderStoryBranchName('{id}', { id: 'INC-7', title }), 'INC-7');
  assert.equal(renderStoryBranchName('bugfix/{title}/{id}', { id: 'B-1', title: 'Café crème' }), 'bugfix/cafe-creme/B-1');
  // A title unknown at start (a Jira or GitHub source) leaves {title} out with one separator.
  assert.equal(renderStoryBranchName('feature/{id}-{title}', { id: 'INC-7' }), 'feature/INC-7');
  assert.equal(renderStoryBranchName('{title}-{id}', { id: 'INC-7', title: '!!!' }), 'INC-7');
  assert.equal(renderStoryBranchName('fix/{title}/{id}', { id: 'INC-7' }), 'fix/INC-7');
  assert.equal(renderStoryBranchName('feature/{id}_{title}_x', { id: 'INC-7' }), 'feature/INC-7_x');
});

test('a new Story is named from the pattern; a person\'s --ref and an existing Story keep theirs', async (t) => {
  const root = await repository(t, 'version: 2\ngit:\n  remote: origin\n  branchNaming:\n    pattern: feature/{id}-{title}\n');
  const named = { title: 'Fix the login page' };
  assert.deepEqual(await applyStoryBranchNaming('ABC-1', named, root),
    { branch: 'feature/ABC-1-fix-the-login-page', existing: false, pattern: 'feature/{id}-{title}' });
  assert.equal(named.ref, 'feature/ABC-1-fix-the-login-page');
  // From a subdirectory too: the checkout top is found without Git.
  await mkdir(path.join(root, 'docs/deep'), { recursive: true });
  const nested = { title: 'Fix the login page' };
  await applyStoryBranchNaming('ABC-1', nested, path.join(root, 'docs/deep'));
  assert.equal(nested.ref, 'feature/ABC-1-fix-the-login-page');

  const typed = { ref: 'bugfix/userprofile/bugfix1', title: 'ignored' };
  assert.equal(await applyStoryBranchNaming('ABC-2', typed, root), null);
  assert.equal(typed.ref, 'bugfix/userprofile/bugfix1', 'the name the person gave is used as given');

  // Started before the pattern existed: its branch is the ID, and it keeps it.
  git(root, 'branch', 'ABC-3');
  const legacy = { title: 'Anything' };
  assert.deepEqual(await applyStoryBranchNaming('ABC-3', legacy, root),
    { branch: 'ABC-3', existing: true, pattern: 'feature/{id}-{title}' });
  assert.equal(legacy.ref, undefined);
});

test('without a pattern nothing is read or changed', async (t) => {
  const root = await repository(t, 'version: 2\ngit:\n  remote: origin\n');
  const options = { title: 'Fix the login page' };
  assert.equal(await applyStoryBranchNaming('ABC-1', options, root), null);
  assert.deepEqual(options, { title: 'Fix the login page' });
  const plain = await repository(t, 'version: 2\ngit:\n  branchNaming:\n    pattern: "{id}"\n');
  assert.equal(await applyStoryBranchNaming('ABC-1', {}, plain), null, 'the default pattern is the ID');
});
