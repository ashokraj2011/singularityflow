import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/util.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

async function remoteRepository(base, name) {
  const source = path.join(base, `${name}-source`);
  const remote = path.join(base, `${name}.git`);
  await mkdir(source, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], { cwd: source });
  run('git', ['config', 'user.name', 'Journey Author'], { cwd: source });
  run('git', ['config', 'user.email', 'journey.author@example.com'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), `# ${name}\n`);
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'application baseline'], { cwd: source });
  run('git', ['clone', '-q', '--bare', source, remote], { cwd: base });
  return {
    source,
    remote,
    main: run('git', ['rev-parse', 'main'], { cwd: remote }).stdout.trim()
  };
}

function journeyEnvironment(base) {
  const machine = path.join(base, 'machine');
  return {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Journey Reviewer',
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'),
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(machine, 'organisation-cache'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(machine, 'bootstrap'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(machine, 'transport-outbox'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Journey Reviewer',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'journey.reviewer@example.com'
  };
}

function invoke(env, cwd, args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, env, encoding: 'utf8', timeout: 120_000
  });
  assert.equal(result.status, expectStatus,
    `singularity-flow ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function invokeJson(env, cwd, args) {
  const result = invoke(env, cwd, [...args, '--json']);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`Command did not return JSON (${error.message}):\n${result.stdout}\n${result.stderr}`);
  }
}

async function protectConfigurationBranch(remote) {
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh
while read old new ref
do
  if [ "$ref" = "refs/heads/sflow/config" ]; then
    echo "protected branch: review required" >&2
    exit 1
  fi
done
exit 0
`);
  await chmod(hook, 0o755);
  return hook;
}

async function externallyMerge(remote, branch, hook) {
  const disabled = `${hook}.disabled`;
  await rename(hook, disabled);
  const review = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-review-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', remote, review]);
    run('git', ['config', 'user.name', 'External Reviewer'], { cwd: review });
    run('git', ['config', 'user.email', 'external.reviewer@example.com'], { cwd: review });
    run('git', ['fetch', '-q', 'origin', branch], { cwd: review });
    run('git', ['merge', '--ff-only', `origin/${branch}`], { cwd: review });
    run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: review });
  } finally {
    await rm(review, { recursive: true, force: true });
  }
  return disabled;
}

test('capability review through workspace creation reaches a governed first Story', {
  timeout: 180_000
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-journey-'));
  const env = journeyEnvironment(base);
  try {
    const platform = await remoteRepository(base, 'platform');
    const delivery = await remoteRepository(base, 'payments-api');

    const mapped = invokeJson(env, base, [
      'capability', 'map', 'payments-api',
      '--lead', platform.remote,
      '--name', 'Payments API',
      '--kind', 'delivery',
      '--repository', delivery.remote
    ]);
    assert.match(mapped.branch, /^sflow\/config-change\/capability\/map-payments-api-/);
    assert.match(mapped.commit, /^[0-9a-f]{40}$/);
    assert.equal(run('git', ['rev-parse', 'main'], { cwd: platform.remote }).stdout.trim(), platform.main);
    assert.equal(run('git', ['rev-parse', 'main'], { cwd: delivery.remote }).stdout.trim(), delivery.main);

    const reviewed = invokeJson(env, base, [
      'capability', 'proposal', mapped.branch, '--lead', platform.remote
    ]);
    assert.equal(reviewed.valid, true);
    assert.equal(reviewed.merged, false);
    assert.equal(reviewed.proposalCommit, mapped.commit);
    assert.deepEqual(reviewed.invalidFiles, []);
    assert.deepEqual(reviewed.changedFiles.map((entry) => entry.paths).flat().sort(), [
      'singularity/capabilities.yml', 'singularity/portfolio.yml'
    ]);

    const hook = await protectConfigurationBranch(platform.remote);
    const waiting = invokeJson(env, base, [
      'capability', 'activate', mapped.branch,
      '--lead', platform.remote,
      '--confirm', mapped.commit,
      '--acknowledge-unprotected'
    ]);
    assert.equal(waiting.status, 'review-required');
    assert.equal(waiting.activated, false);
    assert.equal(waiting.externalAction.sourceBranch, mapped.branch);
    assert.equal(waiting.externalAction.targetBranch, 'sflow/config');
    assert.equal(run('git', ['rev-parse', 'sflow/config'], { cwd: platform.remote }).stdout.trim(), mapped.baseCommit);

    await externallyMerge(platform.remote, mapped.branch, hook);
    const activated = invokeJson(env, base, [
      'capability', 'activate', mapped.branch,
      '--lead', platform.remote,
      '--confirm', mapped.commit,
      '--acknowledge-unprotected'
    ]);
    assert.equal(activated.status, 'activated');
    assert.equal(activated.activated, true);
    assert.equal(activated.alreadyMerged, true);
    assert.equal(activated.audit.recorded, true);
    assert.match(activated.audit.ledgerCommit, /^[0-9a-f]{40}$/);
    assert.equal(run('git', ['rev-parse', 'state'], { cwd: platform.remote }).stdout.trim(),
      activated.projection.commit ?? activated.audit.ledgerCommit);
    const activatedConfiguration = run('git', ['rev-parse', 'sflow/config'], {
      cwd: platform.remote
    }).stdout.trim();
    const activatedState = run('git', ['rev-parse', 'state'], { cwd: platform.remote }).stdout.trim();
    const reconciled = invokeJson(env, base, [
      'capability', 'activate', mapped.branch,
      '--lead', platform.remote,
      '--confirm', mapped.commit,
      '--acknowledge-unprotected'
    ]);
    assert.equal(reconciled.status, 'activated');
    assert.equal(reconciled.audit.duplicate, true,
      'retrying acknowledgement reconciles the existing audit instead of adding another decision');
    assert.equal(run('git', ['rev-parse', 'sflow/config'], { cwd: platform.remote }).stdout.trim(),
      activatedConfiguration);
    assert.equal(run('git', ['rev-parse', 'state'], { cwd: platform.remote }).stdout.trim(),
      activatedState);

    const prepared = invokeJson(env, base, [
      'workspace', 'prepare', platform.remote,
      '--id', 'payments-work',
      '--name', 'Payments Work',
      '--base', path.join(base, 'workspaces'),
      '--capability', 'payments-api',
      '--lead-capability', 'payments-api',
      '--initialize'
    ]);
    assert.equal(prepared.status, 'waiting-user');
    assert.equal(prepared.preflight.ready, true, JSON.stringify(prepared.preflight.findings));
    assert.equal(prepared.plan.createInput.capabilityAuthority.url, platform.remote);

    const bootstrapped = invokeJson(env, base, [
      'workspace', 'bootstrap', 'resume', prepared.bootstrapId,
      '--confirm', 'payments-work'
    ]);
    assert.equal(bootstrapped.status, 'ready', JSON.stringify(bootstrapped.initialization));
    assert.equal(bootstrapped.result.workspace.capabilityAuthority.url, platform.remote);
    const workspacePath = bootstrapped.result.workspace.path;
    const repositoryPath = path.join(workspacePath,
      bootstrapped.result.workspace.repositories['payments-api'].path);
    const resumedAgain = invokeJson(env, base, [
      'workspace', 'bootstrap', 'resume', prepared.bootstrapId,
      '--confirm', 'payments-work'
    ]);
    assert.equal(resumedAgain.status, 'ready');
    assert.equal(resumedAgain.result.workspace.path, workspacePath,
      'repeated resume returns the completed bootstrap without cloning again');

    const selected = invokeJson(env, base, [
      'workspace', 'use', 'payments-work', '--repository', 'payments-api'
    ]);
    assert.equal(selected.repositoryPath, repositoryPath);
    assert.equal(invokeJson(env, base, ['workspace', 'current']).repositoryPath, repositoryPath);

    const started = invokeJson(env, repositoryPath, [
      'start', 'PAY-101',
      '--title', 'Add payment status',
      '--description', 'Expose the current payment status to callers.',
      '--acceptance-criteria', 'Returns the persisted payment status for an existing payment.',
      '--from-branch', 'main',
      '--work-type', 'feature',
      '--capability', 'payments-api'
    ]);
    assert.equal(started.outcome.status, 'succeeded');
    assert.equal(started.data.workItem.id, 'PAY-101');
    assert.equal(started.data.currentPhase, 'intake');
    assert.equal(started.data.publication.pushed, true);
    assert.match(run('git', ['ls-remote', delivery.remote, 'refs/heads/PAY-101'], {
      cwd: repositoryPath
    }).stdout, /refs\/heads\/PAY-101/);
    const source = JSON.parse(run('git', [
      'show', 'PAY-101:singularity/configuration-source.json'
    ], { cwd: delivery.remote }).stdout);
    assert.equal(source.repository, platform.remote,
      'Story intake pins the organisation authority, not an independently initialized delivery config');
    assert.equal(source.commit,
      run('git', ['rev-parse', 'sflow/config'], { cwd: platform.remote }).stdout.trim());
    const publishedStory = run('git', ['rev-parse', 'PAY-101'], { cwd: delivery.remote }).stdout.trim();
    const resumedStory = invokeJson(env, repositoryPath, [
      'start', 'PAY-101',
      '--title', 'Add payment status',
      '--description', 'Expose the current payment status to callers.',
      '--acceptance-criteria', 'Returns the persisted payment status for an existing payment.',
      '--from-branch', 'main',
      '--work-type', 'feature',
      '--capability', 'payments-api'
    ]);
    assert.equal(resumedStory.outcome.status, 'succeeded');
    assert.equal(run('git', ['rev-parse', 'PAY-101'], { cwd: delivery.remote }).stdout.trim(),
      publishedStory, 'retrying Story intake resumes the durable Story without another commit');
    assert.equal(run('git', ['rev-parse', 'main'], { cwd: platform.remote }).stdout.trim(), platform.main);
    assert.equal(run('git', ['rev-parse', 'main'], { cwd: delivery.remote }).stdout.trim(), delivery.main);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
