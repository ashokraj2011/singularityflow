import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { assertLocalConfigurationAuthoringAllowed } from '../src/configuration-proposal.mjs';
import { run } from '../src/util.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposal-'));
  const seed = path.join(base, 'seed');
  const remote = path.join(base, 'application.git');
  const story = path.join(base, 'story');
  const outbox = path.join(base, 'transport-outbox');

  run('git', ['init', '-q', '-b', 'main', seed]);
  run('git', ['config', 'user.name', 'Workflow Author'], { cwd: seed });
  run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: seed });
  await initializeDefinition(seed);
  await writeFile(path.join(seed, 'README.md'), '# Application\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'application and configuration baseline'], { cwd: seed });
  run('git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: seed });
  const approved = run('git', ['rev-parse', 'HEAD'], { cwd: seed }).stdout.trim();

  run('git', ['switch', '-q', '-c', 'CFA-STORY'], { cwd: seed });
  await mkdir(path.join(seed, 'singularity'), { recursive: true });
  await writeFile(path.join(seed, 'singularity', 'configuration-source.json'), `${JSON.stringify({
    branch: 'sflow/config', commit: approved
  }, null, 2)}\n`);
  run('git', ['add', 'singularity/configuration-source.json'], { cwd: seed });
  run('git', ['commit', '-qm', 'pin Story configuration'], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'CFA-STORY'], { cwd: seed });

  run('git', ['clone', '-q', '-b', 'CFA-STORY', remote, story]);
  run('git', ['config', 'user.name', 'Workflow Author'], { cwd: story });
  run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: story });
  return { base, remote, story, outbox, approved };
}

test('workflow proposals publish from approved configuration without changing the selected Story', async () => {
  const item = await fixture();
  try {
    const storyHead = run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim();
    const storyWorkflow = await readFile(path.join(item.story, 'singularity', 'workflow.yml'), 'utf8');
    const created = spawnSync(process.execPath, [
      cli, 'workflow', 'create', 'customer-onboarding',
      '--label', 'Customer onboarding', '--description', 'A reviewed delivery path.',
      '--phases', 'intake,implementation', '--governs', 'story', '--propose', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
      }
    });
    assert.equal(created.status, 0, `${created.stderr}\n${created.stdout}`);
    const result = JSON.parse(created.stdout);

    assert.equal(result.reviewRequired, true);
    assert.equal(result.pushed, true);
    assert.match(result.branch, /^sflow\/config-change\/workflow\/create-workflow-customer-onboarding-/);
    assert.deepEqual(result.files, ['singularity/workflow.yml']);
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim(), storyHead);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: item.story }).stdout.trim(), 'CFA-STORY');
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: item.story }).stdout, '');
    assert.equal(await readFile(path.join(item.story, 'singularity', 'workflow.yml'), 'utf8'), storyWorkflow);
    assert.equal(run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(), item.approved,
      'approved configuration waits for review');

    const proposed = YAML.parse(run('git', [
      '--git-dir', item.remote, 'show', `${result.branch}:singularity/workflow.yml`
    ]).stdout);
    assert.deepEqual(proposed.workTypes['customer-onboarding'].phases, ['intake', 'implementation']);
    assert.match(result.nextAction, /Merge .* into sflow\/config.*refresh-configuration/);

    const retried = spawnSync(process.execPath, [
      cli, 'workflow', 'create', 'customer-onboarding',
      '--label', 'Customer onboarding', '--description', 'A reviewed delivery path.',
      '--phases', 'intake,implementation', '--governs', 'story', '--propose', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
      }
    });
    assert.equal(retried.status, 0, `${retried.stderr}\n${retried.stdout}`);
    const recovered = JSON.parse(retried.stdout);
    assert.equal(recovered.branch, result.branch);
    assert.equal(recovered.commit, result.commit);
    assert.equal(recovered.transportStatus, 'succeeded-existing');
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim(), storyHead);
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: item.story }).stdout, '');

    const pendingList = spawnSync(process.execPath, [
      cli, 'workflow', 'list', '--json'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(pendingList.status, 0, pendingList.stderr || pendingList.stdout);
    const pendingWorkflow = JSON.parse(pendingList.stdout)
      .find((entry) => entry.id === 'customer-onboarding');
    assert.equal(pendingWorkflow.status, 'pending-review');
    assert.equal(pendingWorkflow.installed, false);
    assert.equal(pendingWorkflow.proposalBranch, result.branch);

    const startListBefore = spawnSync(process.execPath, [
      cli, 'workflow', 'list', '--json', '--for-start'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(startListBefore.status, 0, startListBefore.stderr || startListBefore.stdout);
    assert.equal(JSON.parse(startListBefore.stdout)
      .some((entry) => entry.id === 'customer-onboarding' && entry.installed), false,
    'pending review is visible but cannot be selected for governed work');

    const inspected = spawnSync(process.execPath, [
      cli, 'workflow', 'proposal', result.branch, '--json'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    const review = JSON.parse(inspected.stdout);
    assert.equal(review.proposalCommit, result.commit);
    assert.deepEqual(review.workflows.map((entry) => [entry.id, entry.change]), [
      ['customer-onboarding', 'added']
    ]);

    const unacknowledged = spawnSync(process.execPath, [
      cli, 'workflow', 'activate', result.branch, '--confirm', result.commit, '--json'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.notEqual(unacknowledged.status, 0);
    assert.match(unacknowledged.stderr, /branch protection is not enforced/i);
    assert.equal(run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(), item.approved,
      'an unprotected authority does not move without its separate acknowledgement');

    const activated = spawnSync(process.execPath, [
      cli, 'workflow', 'activate', result.branch, '--confirm', result.commit,
      '--acknowledge-unprotected', '--json'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(activated.status, 0, activated.stderr || activated.stdout);
    const activation = JSON.parse(activated.stdout);
    assert.equal(activation.activated, true);
    assert.notEqual(activation.targetCommit, item.approved);
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim(), storyHead,
      'activation never switches or commits the selected Story checkout');

    const startListAfter = spawnSync(process.execPath, [
      cli, 'workflow', 'list', '--json', '--for-start'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(startListAfter.status, 0, startListAfter.stderr || startListAfter.stdout);
    const approvedWorkflow = JSON.parse(startListAfter.stdout)
      .find((entry) => entry.id === 'customer-onboarding');
    assert.equal(approvedWorkflow.status, 'local');
    assert.equal(approvedWorkflow.installed, true);

    const configurationSnapshot = spawnSync(process.execPath, [
      cli, 'snapshot', '--include', 'configuration', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 16 * 1024 * 1024
    });
    assert.equal(configurationSnapshot.status, 0,
      configurationSnapshot.stderr || configurationSnapshot.stdout);
    assert.ok(JSON.parse(configurationSnapshot.stdout)
      .configuration.definition.workTypes['customer-onboarding'],
    'Configuration Center reads newly approved authority even while an older Story stays selected');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('legacy workflow authoring refuses a pinned Story before it writes', async () => {
  const item = await fixture();
  try {
    const before = await readFile(path.join(item.story, 'singularity', 'workflow.yml'), 'utf8');
    assert.throws(() => assertLocalConfigurationAuthoringAllowed(item.story), (error) => {
      assert.equal(error.code, 'WORKFLOW_AUTHORING_STORY_SNAPSHOT_REFUSED');
      assert.match(error.message, /--propose/);
      return true;
    });
    assert.equal(await readFile(path.join(item.story, 'singularity', 'workflow.yml'), 'utf8'), before);
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: item.story }).stdout, '');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});
