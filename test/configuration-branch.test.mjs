import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  CONFIGURATION_BRANCH, CONFIGURATION_SOURCE_PATH, ensureConfigurationBranch,
  configurationAssetPaths, isConfigurationAsset, materializeConfigurationSnapshot, readConfigurationSource,
  STATE_CONFIGURATION_MANIFEST
} from '../src/configuration-branch.mjs';
import { loadDefinition } from '../src/config.mjs';
import { publishCurrentIdentityToConfiguration } from '../src/configuration-people.mjs';
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

async function publishStateConfigurationMirror(fixture) {
  const approved = path.join(fixture.root, 'state-mirror-source');
  const publisher = path.join(fixture.root, 'state-mirror-publisher');
  run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, approved], { cwd: fixture.root });
  run('git', ['init', '-q', '-b', 'state', publisher], { cwd: fixture.root });
  run('git', ['config', 'user.name', 'Configuration Mirror'], { cwd: publisher });
  run('git', ['config', 'user.email', 'mirror@example.com'], { cwd: publisher });
  await cp(path.join(approved, 'singularity'), path.join(publisher, 'singularity'), { recursive: true });
  await cp(path.join(approved, '.github'), path.join(publisher, '.github'), { recursive: true });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: approved }).stdout.trim();
  const files = {};
  for (const relative of await configurationAssetPaths(publisher)) {
    files[relative] = createHash('sha256').update(await readFile(path.join(publisher, relative))).digest('hex');
  }
  const manifest = {
    format: 'singularity-flow-configuration-mirror/v2',
    layout: 'canonical-paths',
    source: { branch: CONFIGURATION_BRANCH, commit: sourceCommit },
    product: { version: 'test', revision: 'test' },
    files
  };
  await mkdir(path.join(publisher, 'configuration'), { recursive: true });
  await writeFile(path.join(publisher, STATE_CONFIGURATION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: publisher });
  run('git', ['commit', '-qm', 'Mirror approved configuration'], { cwd: publisher });
  run('git', ['remote', 'add', 'origin', fixture.remote], { cwd: publisher });
  run('git', ['push', '-q', 'origin', 'state'], { cwd: publisher });
  return {
    sourceCommit,
    stateCommit: run('git', ['rev-parse', 'HEAD'], { cwd: publisher }).stdout.trim()
  };
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

test('first capability authority never checks out an irrelevant monorepo application tree', async () => {
  const fixture = await repositoryFixture();
  const environmentKeys = [
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    // A required smudge filter represents LFS/code-generation work a large application checkout
    // may perform. It deliberately fails: configuration bootstrap has no reason to invoke it.
    await writeFile(path.join(fixture.source, 'large-application.bin'), Buffer.alloc(2 * 1024 * 1024, 0x5a));
    run('git', ['add', 'large-application.bin'], { cwd: fixture.source });
    run('git', ['commit', '-qm', 'large application payload'], { cwd: fixture.source });
    await writeFile(path.join(fixture.source, '.gitattributes'),
      'large-application.bin filter=monorepo required\n');
    run('git', ['add', '.gitattributes'], { cwd: fixture.source });
    run('git', ['commit', '-qm', 'application checkout filter'], { cwd: fixture.source });
    run('git', ['push', '-q', fixture.remote, 'main:main'], { cwd: fixture.source });
    run('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: fixture.remote });

    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'filter.monorepo.smudge',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'filter.monorepo.required',
      GIT_CONFIG_VALUE_1: 'true'
    });

    const result = await ensureConfigurationBranch(fixture.remote);
    assert.equal(result.created, true);
    assert.equal(run('git', ['show', `${CONFIGURATION_BRANCH}:singularity/company-policy.md`], {
      cwd: fixture.remote
    }).stdout, '# Preserve this policy\n', 'the governed configuration bytes are still imported');
    assert.notEqual(run('git', [
      'cat-file', '-e', `${CONFIGURATION_BRANCH}:large-application.bin`
    ], { cwd: fixture.remote, allowFailure: true }).status, 0,
    'application blobs never enter the orphan configuration authority');
  } finally {
    for (const key of environmentKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
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
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'CFG-100');
    const workflow = JSON.parse(await readFile(
      path.join(checkout, 'singularity', 'work-items', 'CFG-100', 'workflow.json'), 'utf8'
    ));
    assert.match(workflow.resolution.configurationSource.commit, /^[0-9a-f]{40}$/);
    assert.equal(workflow.resolution.configurationSource.branch, CONFIGURATION_BRANCH);
    assert.equal(workflow.phases.intake.approvalPolicy.allowSelfApproval, true,
      'new Stories pin the default self-approval control');
    assert.ok(Object.values(workflow.resolution.approvalAuthorities).every((authority) =>
      authority.members.some((member) => member.email === 'story@example.com')),
    'the Story pins its starter identity in every approval group');
    const approvedWorkflow = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/workflow.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.ok(Object.values(approvedWorkflow.approvalAuthorities).every((authority) =>
      authority.members.some((member) => member.email === 'story@example.com')),
    'automatic enrollment is published before configuration is materialized');
    assert.equal(approvedWorkflow.approvalSecurity.autoEnrollNewIdentities, true);
    const approvedPortfolio = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/portfolio.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.ok(Object.values(approvedPortfolio.approvalAuthorities).every((authority) =>
      authority.members.some((member) => member.email === 'story@example.com')),
    'automatic enrollment covers every Initiative approval group too');
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

test('Story start recovers from a verified state mirror when sflow/config is unavailable', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const mirrored = await publishStateConfigurationMirror(fixture);
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], { cwd: fixture.remote });
    const checkout = path.join(fixture.root, 'state-only-story-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'State Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'state-story@example.com'], { cwd: checkout });

    const branches = spawnSync(process.execPath, [cli, 'workspace', 'branches', '--json'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(branches.status, 0, branches.stderr || branches.stdout);
    assert.ok(JSON.parse(branches.stdout).choices.some((choice) => choice.branch === 'main' && choice.everywhere),
      'the VS Code base-branch command reads the local verified state mirror too');

    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-STATE', '--json', '--title', 'Use state recovery configuration',
      '--description', 'Create a Story when only the verified state mirror is available.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const workflow = JSON.parse(await readFile(
      path.join(checkout, 'singularity/work-items/CFG-STATE/workflow.json'), 'utf8'
    ));
    assert.equal(workflow.resolution.configurationSource.commit, mirrored.sourceCommit);
    assert.deepEqual(workflow.resolution.configurationSource.mirror, {
      branch: 'state', commit: mirrored.stateCommit
    });
    assert.equal(run('git', ['cat-file', '-e', 'main:singularity/workflow.yml'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 128, 'application main remains configuration-free');
    assert.equal(run('git', ['cat-file', '-e', 'CFG-STATE:singularity/configuration-source.json'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 0, 'the Story publishes hash-bound state-mirror provenance');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a state mirror with changed bytes is not a Story configuration authority', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    await publishStateConfigurationMirror(fixture);
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], { cwd: fixture.remote });
    const tamper = path.join(fixture.root, 'tampered-state');
    run('git', ['clone', '-q', '-b', 'state', fixture.remote, tamper], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Mirror'], { cwd: tamper });
    run('git', ['config', 'user.email', 'mirror@example.com'], { cwd: tamper });
    await writeFile(path.join(tamper, 'singularity/workflow.yml'), 'version: 2\n');
    run('git', ['add', 'singularity/workflow.yml'], { cwd: tamper });
    run('git', ['commit', '-qm', 'Tamper with mirrored bytes'], { cwd: tamper });
    run('git', ['push', '-q', 'origin', 'state'], { cwd: tamper });

    const checkout = path.join(fixture.root, 'tampered-state-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    await assert.rejects(
      () => materializeConfigurationSnapshot(checkout, { remote: fixture.remote }),
      /mirror hash does not match/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Story start changes nothing when neither configuration authority is available', async () => {
  const fixture = await repositoryFixture();
  try {
    const checkout = path.join(fixture.root, 'no-authority-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'No Authority Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'no-authority@example.com'], { cwd: checkout });
    const before = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-NONE', '--json', '--title', 'No authority',
      '--description', 'Refuse without configuration authority.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.notEqual(started.status, 0);
    assert.match(started.stderr, /Neither an approved sflow\/config branch nor a verified state configuration mirror/);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'main');
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim(), before);
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: checkout }).stdout, '');
    assert.notEqual(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/CFG-NONE'], {
      cwd: checkout, allowFailure: true
    }).status, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('automatic identity enrollment obeys the approved configuration switch', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const approved = path.join(fixture.root, 'approved-auto-enrollment-off');
    run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, approved], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Tester'], { cwd: approved });
    run('git', ['config', 'user.email', 'configuration@example.com'], { cwd: approved });
    const workflowFile = path.join(approved, 'singularity/workflow.yml');
    const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
    workflow.approvalSecurity.autoEnrollNewIdentities = false;
    await writeFile(workflowFile, YAML.stringify(workflow));
    run('git', ['add', 'singularity/workflow.yml'], { cwd: approved });
    run('git', ['commit', '-qm', 'disable automatic identity enrollment'], { cwd: approved });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: approved });

    const checkout = path.join(fixture.root, 'auto-enrollment-off-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Unlisted Developer'], { cwd: checkout });
    run('git', ['config', 'user.email', 'unlisted@example.com'], { cwd: checkout });
    const result = await publishCurrentIdentityToConfiguration(checkout, { automatic: true });
    assert.equal(result.changed, false);
    assert.equal(result.skipped, 'automatic-enrollment-disabled');

    const after = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/workflow.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.ok(Object.values(after.approvalAuthorities).every((authority) =>
      !authority.members.some((member) => member.email === 'unlisted@example.com')));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('failed Story start restores materialized configuration so retries reach the real refusal', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const approved = path.join(fixture.root, 'approved-invalid-id');
    run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, approved], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Tester'], { cwd: approved });
    run('git', ['config', 'user.email', 'configuration@example.com'], { cwd: approved });
    const workflowFile = path.join(approved, 'singularity/workflow.yml');
    const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
    workflow.idPattern = '^CFG-[0-9]+$';
    await writeFile(workflowFile, YAML.stringify(workflow));
    run('git', ['add', 'singularity/workflow.yml'], { cwd: approved });
    run('git', ['commit', '-qm', 'restrict governed Story identifiers'], { cwd: approved });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: approved });

    const checkout = path.join(fixture.root, 'failed-story-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    const invoke = () => spawnSync(process.execPath, [
      cli, 'start', 'WORK-ANU', '--title', 'Reach the real refusal',
      '--description', 'A failed materialization must not poison the next attempt.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = invoke();
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /Work ID WORK-ANU does not match \^CFG-\[0-9\]\+\$/);
      assert.doesNotMatch(failed.stderr, /Working tree is not clean/);
      assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'main');
      assert.equal(run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: checkout
      }).stdout, '');
      assert.notEqual(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/WORK-ANU'], {
        cwd: checkout, allowFailure: true
      }).status, 0);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Story start from a governance proposal still materializes approved configuration', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'governance-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    run('git', ['switch', '-q', '-c', 'sflow/govern/application-review'], { cwd: checkout });
    await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    run('git', ['add', '-A'], { cwd: checkout });
    run('git', ['commit', '-qm', 'review governed configuration'], { cwd: checkout });

    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-REVIEW', '--title', 'Start from reviewed governance',
      '--description', 'Cut the Story from main and pin approved configuration.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer', '--json'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

    assert.equal(started.status, 0, started.stderr || started.stdout);
    const result = JSON.parse(started.stdout);
    assert.equal(result.data.workItem.id, 'CFG-REVIEW');
    assert.equal(result.data.currentPhase, 'intake');
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'CFG-REVIEW');
    assert.equal(run('git', ['cat-file', '-e', 'CFG-REVIEW:singularity/configuration-source.json'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 0, 'the Story branch carries approved configuration provenance');
    assert.notEqual(run('git', ['cat-file', '-e', 'main:singularity/workflow.yml'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 0, 'application main remains unchanged');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
