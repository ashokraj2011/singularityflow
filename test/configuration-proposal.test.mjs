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
