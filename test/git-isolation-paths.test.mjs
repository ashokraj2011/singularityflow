import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gitDisabledHooksPath, gitEmptyConfigPath } from '../src/git-isolation-paths.mjs';
import { enterpriseGitEnvironment } from '../src/git-enterprise-environment.mjs';

test('Git isolation uses an empty regular config and hook directory on Windows', () => {
  // Injecting the platform keeps this contract testable on macOS/Linux too. The Windows lane below
  // additionally launches native Git for Windows with the production environment.
  const config = gitEmptyConfigPath('win32');
  const hooks = gitDisabledHooksPath('win32');
  assert.equal(statSync(config).isFile(), true);
  assert.equal(statSync(config).size, 0);
  assert.equal(statSync(hooks).isDirectory(), true);
  assert.equal(path.dirname(config), path.dirname(hooks));
  assert.equal(gitEmptyConfigPath('win32'), config);
  assert.equal(gitDisabledHooksPath('win32'), hooks);
  assert.notEqual(config, os.devNull);
});

test('the isolated Git environment reads the real empty file and excludes ambient config', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'sflow-git-isolation-test-'));
  const ambient = path.join(scratch, 'ambient.gitconfig');
  try {
    writeFileSync(ambient, '[user]\n\tname = must-not-enter-isolated-git\n');
    const isolated = enterpriseGitEnvironment({
      ...process.env, GIT_CONFIG_GLOBAL: ambient, GIT_CONFIG_SYSTEM: ambient
    });
    assert.equal(isolated.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(isolated.GIT_CONFIG_GLOBAL, gitEmptyConfigPath());
    assert.equal(isolated.GIT_CONFIG_SYSTEM, gitEmptyConfigPath());
    const listed = spawnSync('git', ['config', '--global', '--list'], {
      cwd: scratch, env: isolated, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(listed.status, 0, listed.stderr || String(listed.error ?? 'Git config read failed'));
    assert.equal(listed.stdout, '');
    const user = spawnSync('git', ['config', '--get', 'user.name'], {
      cwd: scratch, env: isolated, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(user.status, 1, user.stderr || 'Ambient user.name entered isolated Git');
    const remote = path.join(scratch, 'authority.git');
    const initialized = spawnSync('git', ['init', '--bare', '--quiet', remote], {
      cwd: scratch, env: isolated, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(initialized.status, 0, initialized.stderr || 'Local authority setup failed');
    const observed = spawnSync('git', ['ls-remote', '--heads', '--', remote], {
      cwd: scratch, env: isolated, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(observed.status, 0, observed.stderr || 'Isolated Git authority read failed');
    const checkout = path.join(scratch, 'checkout');
    const initializedCheckout = spawnSync('git', ['init', '--quiet', checkout], {
      cwd: scratch, env: isolated, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(initializedCheckout.status, 0,
      initializedCheckout.stderr || 'Local hook-isolation setup failed');
    const committed = spawnSync('git', [
      '-C', checkout, '-c', `core.hooksPath=${gitDisabledHooksPath()}`,
      'commit', '--allow-empty', '-m', 'isolated hook path'
    ], {
      cwd: scratch,
      env: {
        ...isolated,
        GIT_AUTHOR_NAME: 'Isolation Test', GIT_AUTHOR_EMAIL: 'isolation@example.test',
        GIT_COMMITTER_NAME: 'Isolation Test', GIT_COMMITTER_EMAIL: 'isolation@example.test'
      },
      encoding: 'utf8', timeout: 10_000
    });
    assert.equal(committed.status, 0, committed.stderr || 'Isolated Git commit failed');
    if (process.platform === 'win32') {
      assert.equal(statSync(isolated.GIT_CONFIG_GLOBAL).isFile(), true);
      assert.equal(statSync(isolated.GIT_CONFIG_GLOBAL).size, 0);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('Git reads reviewed credential helpers through the isolated config path', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'sflow-git-helper-test-'));
  const system = path.join(scratch, 'system.gitconfig');
  const global = path.join(scratch, 'global.gitconfig');
  try {
    // These are inert helper names: the test reads configuration but never asks Git for a credential.
    writeFileSync(system, '[credential]\n\thelper = sflow-test-system-helper\n');
    writeFileSync(global, '[credential]\n\thelper =\n\thelper = sflow-test-global-helper\n');
    const isolated = enterpriseGitEnvironment({
      ...process.env,
      GIT_CONFIG_SYSTEM: system,
      GIT_CONFIG_GLOBAL: global
    });
    assert.equal(isolated.GIT_CONFIG_SYSTEM, gitEmptyConfigPath());
    assert.equal(isolated.GIT_CONFIG_GLOBAL, gitEmptyConfigPath());
    assert.equal(isolated.GIT_CONFIG_COUNT, '3');
    const helpers = spawnSync('git', ['config', '--null', '--get-all', 'credential.helper'], {
      cwd: scratch, env: isolated, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(helpers.status, 0, helpers.stderr || String(helpers.error ?? 'Git helper read failed'));
    assert.deepEqual(helpers.stdout.split('\0'), [
      'sflow-test-system-helper', '', 'sflow-test-global-helper', ''
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
