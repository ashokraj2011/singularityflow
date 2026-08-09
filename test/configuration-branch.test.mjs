import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  CONFIGURATION_BRANCH, CONFIGURATION_SOURCE_PATH, ensureConfigurationBranch,
  isConfigurationAsset, materializeConfigurationSnapshot, readConfigurationSource
} from '../src/configuration-branch.mjs';
import { loadDefinition } from '../src/config.mjs';
import { run } from '../src/util.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('configuration asset paths cannot traverse the repository', () => {
  assert.equal(isConfigurationAsset('singularity/workflow.yml'), true);
  assert.equal(isConfigurationAsset('.github/agents/reviewer.agent.md'), true);
  assert.equal(isConfigurationAsset('singularity/../outside.txt'), false);
  assert.equal(isConfigurationAsset('singularity/../../outside.txt'), false);
  assert.equal(isConfigurationAsset('/singularity/workflow.yml'), false);
});

async function repositoryFixture({ branch = 'main' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-configuration-branch-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'application.git');
  run('git', ['init', '-q', '-b', branch, source], { cwd: root });
  run('git', ['config', 'user.name', 'Configuration Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'configuration@example.com'], { cwd: source });
  await mkdir(path.join(source, 'singularity', 'work-items', 'OLD-1'), { recursive: true });
  await mkdir(path.join(source, 'singularity'), { recursive: true });
  await writeFile(path.join(source, 'README.md'), '# Application\n');
  await writeFile(path.join(source, 'singularity', 'company-policy.md'), '# Preserve this policy\n');
  await writeFile(path.join(source, 'singularity', 'work-items', 'OLD-1', 'workflow.json'), '{}\n');
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'application baseline'], { cwd: source });
  run('git', ['clone', '-q', '--bare', source, remote], { cwd: root });
  return { root, source, remote };
}

test('configuration authority pins a non-main application default branch', async () => {
  const fixture = await repositoryFixture({ branch: 'trunk' });
  try {
    await ensureConfigurationBranch(fixture.remote);
    const workflow = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/workflow.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.equal(workflow.defaultBaseBranch, 'trunk');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('concurrent configuration bootstrap never reports a losing capability as published', async () => {
  const fixture = await repositoryFixture();
  const capability = (capabilityId) => ({
    capabilityId, capabilityName: capabilityId.toUpperCase(), kind: 'collection',
    repositoryId: 'application', jiraProject: null, teams: []
  });
  try {
    const results = await Promise.allSettled([
      ensureConfigurationBranch(fixture.remote, { capability: capability('alpha') }),
      ensureConfigurationBranch(fixture.remote, { capability: capability('beta') })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message,
      /does not define requested capability/);
    const map = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/capabilities.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.equal(Object.keys(map.capabilities).length, 1, 'only the winning capability is governed');
    assert.ok(['alpha', 'beta'].includes(Object.keys(map.capabilities)[0]));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('configuration authority is bootstrapped without changing application history', async () => {
  const fixture = await repositoryFixture();
  try {
    const before = run('git', ['rev-parse', 'main'], { cwd: fixture.remote }).stdout.trim();
    const result = await ensureConfigurationBranch(fixture.remote);
    assert.equal(result.branch, CONFIGURATION_BRANCH);
    assert.equal(result.created, true);
    assert.equal(run('git', ['rev-parse', 'main'], { cwd: fixture.remote }).stdout.trim(), before);
    assert.match(run('git', ['show', `${CONFIGURATION_BRANCH}:singularity/workflow.yml`], {
      cwd: fixture.remote
    }).stdout, /^version: 2/m);
    assert.equal(run('git', ['show', `${CONFIGURATION_BRANCH}:singularity/company-policy.md`], {
      cwd: fixture.remote
    }).stdout, '# Preserve this policy\n');
    assert.notEqual(run('git', [
      'cat-file', '-e', `${CONFIGURATION_BRANCH}:singularity/work-items/OLD-1/workflow.json`
    ], { cwd: fixture.remote, allowFailure: true }).status, 0, 'runtime state is never imported as configuration');
    assert.equal((await ensureConfigurationBranch(fixture.remote)).created, false, 'bootstrap is idempotent');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a lifecycle branch receives and verifies one exact approved configuration revision', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    run('git', ['switch', '-q', '-c', 'STORY-100'], { cwd: checkout });

    const snapshot = await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    assert.equal(snapshot.branch, CONFIGURATION_BRANCH);
    assert.match(snapshot.commit, /^[0-9a-f]{40}$/);
    assert.ok(snapshot.paths.includes(CONFIGURATION_SOURCE_PATH));
    assert.equal((await loadDefinition(checkout)).version, 2);

    const provenance = await readConfigurationSource(checkout, { verify: true });
    assert.equal(provenance.commit, snapshot.commit);
    assert.equal(provenance.repository, fixture.remote);
    assert.equal(
      provenance.files['singularity/company-policy.md'],
      snapshot.files['singularity/company-policy.md']
    );

    await writeFile(path.join(checkout, 'singularity', 'company-policy.md'), '# Changed after pinning\n');
    await assert.rejects(
      () => readConfigurationSource(checkout, { verify: true }),
      /Pinned configuration asset changed after materialization/
    );
    assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), '# Application\n');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a later materialization records configuration assets removed by the approved revision', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'checkout-removal');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['switch', '-q', '-c', 'STORY-REMOVE'], { cwd: checkout });
    await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    assert.equal(await readFile(path.join(checkout, 'singularity/company-policy.md'), 'utf8'), '# Preserve this policy\n');

    const approved = path.join(fixture.root, 'approved-config');
    run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, approved], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Tester'], { cwd: approved });
    run('git', ['config', 'user.email', 'configuration@example.com'], { cwd: approved });
    await rm(path.join(approved, 'singularity/company-policy.md'));
    run('git', ['add', '-A'], { cwd: approved });
    run('git', ['commit', '-qm', 'remove obsolete policy'], { cwd: approved });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: approved });

    const refreshed = await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    assert.ok(refreshed.paths.includes('singularity/company-policy.md'));
    await assert.rejects(() => readFile(path.join(checkout, 'singularity/company-policy.md'), 'utf8'), /ENOENT/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Story start materializes approved configuration without requiring it on application main', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'story-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-100', '--title', 'Use approved configuration',
      '--description', 'Prove application main can remain code-only.',
      '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'CFG-100');
    const workflow = JSON.parse(await readFile(
      path.join(checkout, 'singularity', 'work-items', 'CFG-100', 'workflow.json'), 'utf8'
    ));
    assert.match(workflow.resolution.configurationSource.commit, /^[0-9a-f]{40}$/);
    assert.equal(workflow.resolution.configurationSource.branch, CONFIGURATION_BRANCH);
    assert.equal(
      run('git', ['cat-file', '-e', 'main:singularity/workflow.yml'], {
        cwd: fixture.remote, allowFailure: true
      }).status,
      128,
      'application main remains free of Singularity configuration'
    );
    assert.equal(run('git', ['cat-file', '-e', 'CFG-100:singularity/configuration-source.json'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 0, 'the published Story carries configuration provenance');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
