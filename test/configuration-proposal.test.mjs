import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  activateWorkflowConfigurationProposal, assertLocalConfigurationAuthoringAllowed
} from '../src/configuration-proposal.mjs';
import { run } from '../src/util.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

async function fixture({ remoteName = 'application.git' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposal-'));
  const seed = path.join(base, 'seed');
  const remote = path.join(base, remoteName);
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
      '--phases', 'intake,implementation', '--governs', 'story',
      '--planned-claims', 'opt-out', '--opt-out-reason',
      'This reviewed short workflow deliberately has no separate specification phase.',
      '--propose', '--json'
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
    assert.equal(proposed.workTypes['customer-onboarding'].plannedClaims.mode, 'opt-out');
    assert.match(result.nextAction, /Merge .* into sflow\/config.*refresh-configuration/);

    const retried = spawnSync(process.execPath, [
      cli, 'workflow', 'create', 'customer-onboarding',
      '--label', 'Customer onboarding', '--description', 'A reviewed delivery path.',
      '--phases', 'intake,implementation', '--governs', 'story',
      '--planned-claims', 'opt-out', '--opt-out-reason',
      'This reviewed short workflow deliberately has no separate specification phase.',
      '--propose', '--json'
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
    assert.match(unacknowledged.stderr, /cannot prove whether.*protected/is);
    assert.equal(run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(), item.approved,
      'an unprotected authority does not move without its separate acknowledgement');

    const realGit = run('which', ['git']).stdout.trim();
    const wrappers = path.join(item.base, 'git-wrappers');
    const pushLog = path.join(item.base, 'activation-push.jsonl');
    const wrapper = path.join(wrappers, 'git');
    await mkdir(wrappers, { recursive: true });
    await writeFile(wrapper, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'push') fs.appendFileSync(${JSON.stringify(pushLog)}, JSON.stringify(args) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  cwd: process.cwd(), env: process.env, stdio: 'inherit'
});
process.exit(result.status == null ? 1 : result.status);
`);
    await chmod(wrapper, 0o755);
    const activated = spawnSync(process.execPath, [
      cli, 'workflow', 'activate', result.branch, '--confirm', result.commit,
      '--acknowledge-unprotected', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: {
        ...process.env, NO_COLOR: '1', PATH: `${wrappers}${path.delimiter}${process.env.PATH}`
      }
    });
    assert.equal(activated.status, 0, activated.stderr || activated.stdout);
    const activation = JSON.parse(activated.stdout);
    assert.equal(activation.activated, true);
    assert.equal(activation.mergeEvidence, 'direct-exact-lease');
    assert.equal(activation.protection.enforced, false);
    assert.notEqual(activation.targetCommit, item.approved);
    const pushes = (await readFile(pushLog, 'utf8')).trim().split('\n').map(JSON.parse);
    const authorityPush = pushes.find((args) =>
      args.includes('HEAD:refs/heads/sflow/config'));
    assert.ok(authorityPush, 'activation must attempt one observable authority update');
    assert.ok(authorityPush.includes('--porcelain'));
    assert.ok(authorityPush.includes(
      `--force-with-lease=refs/heads/sflow/config:${item.approved}`));
    assert.equal(authorityPush.includes('--dry-run'), false,
      'a dry run is not branch-protection evidence and must not precede the exact update');
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

test('workflow activation keeps a generic pre-receive refusal pending with its diagnostic', async () => {
  const item = await fixture();
  try {
    const created = spawnSync(process.execPath, [
      cli, 'workflow', 'create', 'security-scanned-flow',
      '--label', 'Security scanned flow', '--description', 'A reviewed delivery path.',
      '--phases', 'intake,implementation', '--governs', 'story',
      '--planned-claims', 'opt-out', '--opt-out-reason',
      'This reviewed short workflow deliberately has no separate specification phase.',
      '--propose', '--json'
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
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const proposal = JSON.parse(created.stdout);
    const hook = path.join(item.remote, 'hooks', 'pre-receive');
    await writeFile(hook, `#!/bin/sh
echo "secret scanning rejected a credential in the proposed content" >&2
exit 1
`);
    await chmod(hook, 0o755);

    const waiting = await activateWorkflowConfigurationProposal(item.story, proposal.branch, {
      confirm: proposal.commit,
      acknowledgeUnprotected: true
    });
    assert.equal(waiting.status, 'activation-pending');
    assert.equal(waiting.activated, false);
    assert.equal(waiting.externalAction, null);
    assert.notEqual(waiting.failure.code, 'WORKFLOW_ACTIVATION_REVIEW_REQUIRED');
    assert.match(waiting.failure.diagnostic, /secret scanning rejected a credential/i);
    assert.match(waiting.failure.diagnostic, /pre-receive hook declined/i);
    assert.equal(run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(), item.approved);

    await writeFile(hook, `#!/bin/sh
echo "configuration review required before updating this protected branch" >&2
exit 1
`);
    await chmod(hook, 0o755);
    const protectedRefusal = await activateWorkflowConfigurationProposal(item.story, proposal.branch, {
      confirm: proposal.commit,
      acknowledgeUnprotected: true
    });
    assert.equal(protectedRefusal.status, 'review-required');
    assert.equal(protectedRefusal.failure.code, 'WORKFLOW_ACTIVATION_REVIEW_REQUIRED');
    assert.equal(protectedRefusal.protection.enforced, true);
    assert.equal(protectedRefusal.externalAction.action, 'merge-proposal');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow proposal activation rejects a newly added migration-required Story workflow', async () => {
  const item = await fixture();
  const authoring = path.join(item.base, 'unsafe-proposal');
  const proposalBranch = 'sflow/config-change/workflow/unsafe-legacy-custom';
  try {
    run('git', ['clone', '-q', '-b', 'sflow/config', item.remote, authoring]);
    run('git', ['config', 'user.name', 'Workflow Author'], { cwd: authoring });
    run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: authoring });
    run('git', ['switch', '-q', '-c', proposalBranch], { cwd: authoring });
    const workflowPath = path.join(authoring, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
    definition.workTypes['legacy-custom'] = {
      ...structuredClone(definition.workTypes['quick-fix']),
      label: 'Legacy custom'
    };
    delete definition.workTypes['legacy-custom'].plannedClaims;
    await writeFile(workflowPath, YAML.stringify(definition));
    run('git', ['add', 'singularity/workflow.yml'], { cwd: authoring });
    run('git', ['commit', '-qm', 'propose unresolved legacy workflow'], { cwd: authoring });
    run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${proposalBranch}`], { cwd: authoring });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: authoring }).stdout.trim();

    await assert.rejects(
      () => activateWorkflowConfigurationProposal(item.story, proposalBranch, {
        confirm: commit,
        acknowledgeUnprotected: true
      }),
      (error) => error.code === 'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED'
        && /cannot be added or materially changed/.test(error.message)
    );
    assert.equal(
      run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(),
      item.approved,
      'rejected proposal must not move approved configuration'
    );
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow proposal publication distinguishes local authorities whose display URLs collide', async () => {
  const item = await fixture({ remoteName: 'application.git?blue' });
  try {
    const collision = path.join(item.base, 'application.git?red');
    run('git', ['init', '-q', '--bare', '--initial-branch=main', collision]);
    run('git', ['remote', 'add', 'aaa-display-collision', collision], { cwd: item.story });

    const created = spawnSync(process.execPath, [
      cli, 'workflow', 'create', 'exact-authority',
      '--label', 'Exact authority', '--description', 'Publish only to the selected authority.',
      '--phases', 'intake,implementation', '--governs', 'story',
      '--planned-claims', 'opt-out', '--opt-out-reason',
      'This reviewed short workflow deliberately has no separate specification phase.',
      '--propose', '--json'
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
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const proposal = JSON.parse(created.stdout);
    assert.equal(run('git', [
      '--git-dir', item.remote, 'show-ref', '--verify', '--quiet', `refs/heads/${proposal.branch}`
    ], { allowFailure: true }).status, 0, 'the exact approved authority receives the proposal');
    assert.equal(run('git', [
      '--git-dir', collision, 'show-ref', '--verify', '--quiet', `refs/heads/${proposal.branch}`
    ], { allowFailure: true }).status, 1, 'the display-colliding authority receives nothing');
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
