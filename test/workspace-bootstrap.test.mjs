import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeGitRemote } from '../src/git-remote-diagnostics.mjs';
import {
  abandonWorkspaceBootstrap, prepareWorkspaceBootstrap, readWorkspaceBootstrap,
  resumeWorkspaceBootstrap, workspaceBootstrapRoot
} from '../src/workspace-bootstrap.mjs';
import { run } from '../src/util.mjs';

async function remoteFixture(branch = 'trunk') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-bootstrap-guardian-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  await mkdir(source);
  run('git', ['init', `--initial-branch=${branch}`], { cwd: source });
  run('git', ['config', 'user.name', 'Bootstrap Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'bootstrap@example.com'], { cwd: source });
  run('git', ['commit', '--allow-empty', '-m', 'seed'], { cwd: source });
  run('git', ['clone', '--bare', '--', source, remote], { cwd: root });
  return { root, remote };
}

function environment(root) {
  return {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'state', 'workspaces.json'),
    SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(root, 'state', 'bootstrap'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1'
  };
}

function input(root, remote, branch = 'main') {
  return {
    baseDirectory: path.join(root, 'workspaces'),
    id: 'demo',
    name: 'Demo workspace',
    leadRepository: 'application',
    capabilities: [],
    repositories: {
      application: {
        url: remote,
        defaultBranch: branch,
        required: true,
        path: 'repos/application'
      }
    }
  };
}

test('the public CLI prepares and reads the same durable bootstrap receipt', async () => {
  const fixture = await remoteFixture('trunk');
  const env = environment(fixture.root);
  const cli = path.resolve('bin/singularity-flow.mjs');
  const prepared = JSON.parse(run(process.execPath, [
    cli, 'workspace', 'prepare', fixture.remote,
    '--id', 'cli-demo', '--base', path.join(fixture.root, 'workspaces'),
    '--branch', 'trunk', '--json'
  ], { cwd: fixture.root, env }).stdout);
  assert.equal(prepared.status, 'waiting-user');
  assert.equal(prepared.preflight.ready, true);
  assert.equal(prepared.scope.kind, 'workspace-bootstrap');
  assert.match(prepared.planHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(prepared.attemptBudget, { used: 0, maximum: 3 });

  const status = JSON.parse(run(process.execPath, [
    cli, 'workspace', 'bootstrap', 'status', prepared.bootstrapId, '--json'
  ], { cwd: fixture.root, env }).stdout);
  assert.equal(status.integrity.sha256, prepared.integrity.sha256);
  assert.equal(status.plan.workspace.confirmation, 'cli-demo');
});

test('prepare persists a resumable plan before destination mutation and resume links the clone journal', async () => {
  const fixture = await remoteFixture('trunk');
  const env = environment(fixture.root);
  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.remote },
    createInput: input(fixture.root, fixture.remote),
    inferDefaultRepositories: ['application']
  }, { env });

  assert.equal(prepared.status, 'waiting-user');
  assert.equal(prepared.preflight.ready, true);
  assert.equal(prepared.plan.repositories[0].defaultBranch, 'trunk');
  assert.equal(await readFile(prepared.plan.workspace.targetPath).catch(() => null), null,
    'prepare created the workspace destination');
  assert.equal(prepared.plan.workspace.confirmation, 'demo');

  const resumed = await resumeWorkspaceBootstrap(prepared.bootstrapId, {
    confirmation: 'demo', env
  });
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.attemptBudget.used, 1);
  assert.ok(resumed.createdPaths.includes(resumed.result.workspace.path));
  const journal = JSON.parse(await readFile(resumed.workspaceJournal.path, 'utf8'));
  assert.equal(journal.bootstrapId, prepared.bootstrapId);
  const lead = resumed.result.workspace.repositories.application;
  assert.equal(run('git', ['branch', '--show-current'], {
    cwd: path.join(resumed.result.workspace.path, lead.path)
  }).stdout.trim(), 'trunk');
  const registry = JSON.parse(await readFile(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, 'utf8'));
  assert.equal(registry.workspaces.length, 1);
});

test('an occupied destination is a blocker and no existing byte is adopted', async () => {
  const fixture = await remoteFixture();
  const env = environment(fixture.root);
  const occupied = path.join(fixture.root, 'workspaces', 'demo--demo-workspace');
  await mkdir(occupied, { recursive: true });
  await writeFile(path.join(occupied, 'keep.txt'), 'mine\n');

  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.remote },
    createInput: input(fixture.root, fixture.remote, 'trunk')
  }, { env });
  assert.equal(prepared.preflight.ready, false);
  assert.ok(prepared.preflight.findings.some((entry) => entry.classification === 'target-occupied'));
  assert.equal(await readFile(path.join(occupied, 'keep.txt'), 'utf8'), 'mine\n');
});

test('remote diagnostics classify authentication without retaining provider output or secrets', () => {
  const secret = 'example-secret-value';
  const result = probeGitRemote('https://example.com/acme/repository.git', {
    runCommand: () => ({
      status: 128,
      stdout: '',
      stderr: `fatal: Authentication failed for https://oauth2:${secret}@example.com/acme/repository.git`,
      timedOut: false,
      blocked: false
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.classification, 'authentication-required');
  assert.equal(result.failure.evidence.exitCode, 128);
  assert.match(result.failure.evidence.diagnosticSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(result), /oauth2/);
  assert.throws(() => probeGitRemote(`https://oauth2:${secret}@example.com/acme/repository.git`),
    /credential helper/);
  assert.throws(() => probeGitRemote(`https://example.com/acme/repository.git?access_token=${secret}`),
    /query parameters/);
  assert.throws(() => probeGitRemote('ext::sh -c dangerous'), /external-helper transport/);
});

test('network-disabled preflight records an offline classification without invoking Git', () => {
  let calls = 0;
  const result = probeGitRemote('https://example.com/acme/repository.git', {
    env: { ...process.env, SINGULARITY_FLOW_NO_NETWORK: '1' },
    runCommand: () => { calls += 1; throw new Error('must not run'); }
  });
  assert.equal(calls, 0);
  assert.equal(result.failure.classification, 'offline');
  assert.equal(result.failure.evidence.blocked, true);
});

test('session integrity detects local record tampering', async () => {
  const fixture = await remoteFixture();
  const env = environment(fixture.root);
  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.remote },
    createInput: input(fixture.root, fixture.remote, 'trunk')
  }, { env });
  const file = path.join(workspaceBootstrapRoot(env), 'sessions', `${prepared.bootstrapId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.status = 'ready';
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(() => readWorkspaceBootstrap(prepared.bootstrapId, { env }), (error) => {
    assert.equal(error.code, 'BOOTSTRAP_INTEGRITY_INVALID');
    return true;
  });
});

test('abandon is explicit and preserves an occupied workspace shell', async () => {
  const fixture = await remoteFixture();
  const env = environment(fixture.root);
  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.remote },
    createInput: input(fixture.root, fixture.remote, 'trunk')
  }, { env });
  await assert.rejects(() => abandonWorkspaceBootstrap(prepared.bootstrapId, { env }), /requires --reason/);
  const abandoned = await abandonWorkspaceBootstrap(prepared.bootstrapId, {
    env, reason: 'The demonstration uses a different repository.'
  });
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(await readFile(abandoned.plan.workspace.targetPath).catch(() => null), null);
});
