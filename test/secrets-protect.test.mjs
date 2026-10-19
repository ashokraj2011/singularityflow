import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTemporaryTree } from '../src/util.mjs';

/**
 * `secrets protect` installs the hook where Git runs it, and never says commits are protected when
 * they are not. It used to write `<git-dir>/hooks/pre-commit`: in a linked worktree that is the
 * worktree's private directory, which Git never reads, and with `core.hooksPath` set Git ignores
 * `.git/hooks` altogether. Both reported "commits are now protected".
 */
const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
/** Assembled at runtime so this file is not itself credential-shaped. */
const credential = `AKIA${'Q7RJ2NXWMBK4TZVD'}`;

async function fixture(t) {
  const base = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-secrets-protect-')));
  t.after(() => removeTemporaryTree(base));
  // An empty global configuration: a developer's own core.hooksPath must not decide these tests.
  const globalConfig = path.join(base, 'global.gitconfig');
  await writeFile(globalConfig, '');
  const env = {
    ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    SINGULARITY_FLOW_GIT_FACT_STORE: 'off', HOME: path.join(base, 'home'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Hook Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'hooks@example.invalid',
    GIT_CONFIG_KEY_2: 'commit.gpgsign', GIT_CONFIG_VALUE_2: 'false'
  };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const repo = path.join(base, 'repo');
  git(base, ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), '# Hooks\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', 'Initial']);
  const sflow = (cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
  const protect = (cwd) => {
    const result = sflow(cwd, ['secrets', 'protect', '--json']);
    return { status: result.status, stderr: result.stderr, json: JSON.parse(result.stdout) };
  };
  return { base, env, git, repo, sflow, protect };
}

test('from a linked worktree the hook goes where Git runs it, and Git does run it', async (t) => {
  const { base, env, git, repo, protect } = await fixture(t);
  const worktree = path.join(base, 'feature');
  git(repo, ['worktree', 'add', '-q', '-b', 'feature', worktree]);

  const installed = protect(worktree);
  assert.equal(installed.status, 0, installed.stderr);
  const shared = path.join(repo, '.git', 'hooks', 'pre-commit');
  assert.equal(installed.json.outcome.status, 'succeeded');
  assert.equal(installed.json.data.hook, shared, 'data.hook is the hook Git runs for every worktree');
  assert.equal(installed.json.data.active, true);
  assert.equal(installed.json.data.scope, 'all-worktrees');
  assert.ok(statSync(shared).mode & 0o111, 'the shared hook is executable');
  assert.equal(existsSync(path.join(repo, '.git', 'worktrees', 'feature', 'hooks')), false,
    'nothing is written to the worktree-private directory Git never reads');

  // The proof that matters: plain `git commit` in the linked worktree is refused.
  await writeFile(path.join(worktree, 'config.js'), `export const key = "${credential}";\n`);
  git(worktree, ['add', 'config.js']);
  const committed = spawnSync('git', ['commit', '-qm', 'Add configuration'], { cwd: worktree, env, encoding: 'utf8' });
  assert.notEqual(committed.status, 0, 'the pre-commit hook refused the credential');
  assert.match(committed.stderr, /secret/i);
  assert.doesNotMatch(committed.stderr, new RegExp(credential), 'the refusal never repeats the credential');
});

test('core.hooksPath outside the repository: nothing is written and protection is reported inactive', async (t) => {
  const { base, git, repo, protect } = await fixture(t);
  const managed = path.join(base, 'managed-hooks');
  git(repo, ['config', 'core.hooksPath', managed]);

  const refused = protect(repo);
  assert.equal(refused.status, 2, 'a refusal at the shell too');
  assert.equal(refused.json.outcome.status, 'refused');
  assert.equal(refused.json.outcome.messageId, 'secrets.protection-inactive');
  assert.deepEqual(refused.json.effects, {
    stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false
  });
  assert.equal(refused.json.why[0].code, 'secrets.hooks-path-outside-repository');
  const { data } = refused.json;
  assert.equal(data.hook, path.join(managed, 'pre-commit'), 'data.hook is the hook Git would actually run');
  assert.equal(data.active, false);
  assert.equal(data.installed, false);
  assert.equal(data.code, 'SECRET_HOOK_INACTIVE');
  assert.equal(data.placement, 'outside-repository');
  const [addLine, unset] = data.manualSteps;
  assert.equal(addLine.file, path.join(managed, 'pre-commit'));
  assert.equal(addLine.line, 'sflow secrets scan --staged || exit 1');
  assert.equal(unset.command, 'git config --unset core.hooksPath', 'set in this repository, so the local unset is exact');
  assert.deepEqual(refused.json.next.map((entry) => entry.command),
    ['singularity-flow secrets scan --staged', 'singularity-flow secrets protect']);
  assert.equal(existsSync(managed), false, 'the managed directory was not created');
  assert.equal(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')), false,
    'no hook Git ignores was written to .git/hooks either');
  assert.doesNotMatch(JSON.stringify(refused.json), /now refuses a commit/);

  // After the manual step the same command says so, and still writes nothing.
  await mkdir(managed, { recursive: true });
  await writeFile(path.join(managed, 'pre-commit'), `#!/bin/sh\nrun-linters\n${addLine.line}\n`);
  chmodSync(path.join(managed, 'pre-commit'), 0o755);
  const active = protect(repo);
  assert.equal(active.status, 0, active.stderr);
  assert.equal(active.json.outcome.messageId, 'secrets.protected-by-hooks-path');
  assert.equal(active.json.data.active, true);
  assert.equal(active.json.data.installed, false);
  assert.equal(active.json.effects.filesChanged, false);
  assert.equal(await readFile(path.join(managed, 'pre-commit'), 'utf8'), `#!/bin/sh\nrun-linters\n${addLine.line}\n`);
});

test('core.hooksPath in the working tree is shared or managed, so it is not written either', async (t) => {
  const { git, repo, protect, sflow } = await fixture(t);
  git(repo, ['config', 'core.hooksPath', '.githooks']);
  const refused = protect(repo);
  assert.equal(refused.status, 2);
  assert.equal(refused.json.data.hook, path.join(repo, '.githooks', 'pre-commit'));
  assert.equal(refused.json.data.placement, 'working-tree');
  assert.equal(refused.json.why[0].code, 'secrets.hooks-path-in-working-tree');
  assert.equal(git(repo, ['status', '--porcelain']), '', 'the working tree is untouched');

  const text = sflow(repo, ['secrets', 'protect']);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /Secret protection is not active/);
  assert.match(text.stderr, /sflow secrets scan --staged \|\| exit 1/);
  assert.match(text.stderr, /git config --unset core\.hooksPath/);
  assert.doesNotMatch(text.stdout + text.stderr, /now refuses a commit/);
});

test('core.hooksPath inside the Git directory is still this clone\'s own, so it is installed there', async (t) => {
  const { git, repo, protect } = await fixture(t);
  git(repo, ['config', 'core.hooksPath', '.git/custom-hooks']);
  const installed = protect(repo);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.json.data.hook, path.join(repo, '.git', 'custom-hooks', 'pre-commit'));
  assert.equal(installed.json.data.hooksPathConfigured, true);
  assert.equal(installed.json.data.scope, 'checkout');
  assert.match(await readFile(installed.json.data.hook, 'utf8'), /secrets scan --staged/);
  assert.equal(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')), false);
});
