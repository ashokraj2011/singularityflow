import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { probeGitRemote } from '../src/git-remote-diagnostics.mjs';
import {
  abandonWorkspaceBootstrap, prepareWorkspaceBootstrap, readWorkspaceBootstrap,
  enterpriseGitDiagnostics, portableWorkspacePathFindings, preflightWorkspaceBootstrap,
  resumeWorkspaceBootstrap, retryWorkspaceBootstrap,
  workspaceBootstrapRoot
} from '../src/workspace-bootstrap.mjs';
import { run } from '../src/util.mjs';
import { ensureConfigurationBranch } from '../src/configuration-branch.mjs';
import { fetchWorkspace } from '../src/workspace.mjs';

async function remoteFixture(branch = 'trunk') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-bootstrap-guardian-'));
  const source = path.join(root, 'source');
  // Match the governed repository ID used by the workspace manifest. A differently named remote
  // is a real catalog/manifest binding error now that bootstrap validates the complete delivery
  // closure instead of approving a capability ID in isolation.
  const remote = path.join(root, 'application.git');
  await mkdir(source);
  run('git', ['init', `--initial-branch=${branch}`], { cwd: source });
  run('git', ['config', 'user.name', 'Bootstrap Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'bootstrap@example.com'], { cwd: source });
  run('git', ['commit', '--allow-empty', '-m', 'seed'], { cwd: source });
  run('git', ['clone', '--bare', '--', source, remote], { cwd: root });
  return { root, source, remote };
}

async function writeAuthorityMarker(fixture, branch, value) {
  await mkdir(path.join(fixture.source, 'src'), { recursive: true });
  await writeFile(path.join(fixture.source, 'AUTHORITY.txt'), `${value}\n`);
  await writeFile(path.join(fixture.source, 'src', 'AUTHORITY.txt'), `${value} source\n`);
  run('git', ['add', 'AUTHORITY.txt', 'src/AUTHORITY.txt'], { cwd: fixture.source });
  run('git', ['commit', '-m', `identify ${value} authority`], { cwd: fixture.source });
  run('git', ['push', fixture.remote, branch], { cwd: fixture.source });
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

test('bootstrap blocks unapproved capabilities before materialization and binds them into its plan hash', async () => {
  const fixture = await remoteFixture('trunk');
  const env = environment(fixture.root);
  await ensureConfigurationBranch(fixture.remote, {
    capability: {
      capabilityId: 'declared-capability',
      capabilityName: 'Declared capability',
      kind: 'delivery',
      repositoryId: 'application',
      jiraProject: null,
      teams: []
    }
  });

  const withoutCapability = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.remote },
    createInput: input(fixture.root, fixture.remote, 'trunk')
  }, { env });
  const declaredInput = input(fixture.root, fixture.remote, 'trunk');
  declaredInput.capabilities = ['declared-capability'];
  declaredInput.repositories.application.capabilities = ['declared-capability'];
  const withCapability = await prepareWorkspaceBootstrap({
    source: { kind: 'manifest', reference: fixture.remote },
    createInput: declaredInput
  }, { env });
  assert.equal(withCapability.preflight.ready, true, JSON.stringify(withCapability.preflight.findings));
  assert.notEqual(withCapability.planHash, withoutCapability.planHash,
    'the selected capabilities are part of the reviewed materialization plan');
  const capabilityCheck = withCapability.preflight.checks.find((entry) =>
    entry.id === 'configuration:capability-catalog');
  assert.match(capabilityCheck.capabilityValidation.commit, /^[a-f0-9]{40}$/);
  assert.match(capabilityCheck.capabilityValidation.bindingSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(capabilityCheck.capabilityValidation.requested, ['declared-capability']);

  const invalidInput = input(fixture.root, fixture.remote, 'trunk');
  invalidInput.id = 'invalid-capability';
  invalidInput.name = 'invalid-capability';
  invalidInput.capabilities = ['missing-capability'];
  invalidInput.repositories.application.capabilities = ['missing-capability'];
  const blocked = await prepareWorkspaceBootstrap({
    source: { kind: 'manifest', reference: fixture.remote },
    createInput: invalidInput
  }, { env });
  assert.equal(blocked.preflight.ready, false);
  assert.ok(blocked.preflight.findings.some((entry) => entry.classification === 'capability-unknown'));
  assert.equal(await readFile(blocked.plan.workspace.targetPath).catch(() => null), null,
    'preflight must not create the invalid workspace destination');
});

test('returned preflight diagnostics cannot mutate the held capability authority proof', async () => {
  const fixture = await remoteFixture('trunk');
  const env = environment(fixture.root);
  await ensureConfigurationBranch(fixture.remote, {
    capability: {
      capabilityId: 'declared-capability',
      capabilityName: 'Declared capability',
      kind: 'delivery',
      repositoryId: 'application',
      jiraProject: null,
      teams: []
    }
  });
  const declaredInput = input(fixture.root, fixture.remote, 'trunk');
  declaredInput.capabilities = ['declared-capability'];
  declaredInput.repositories.application.capabilities = ['declared-capability'];
  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'manifest', reference: fixture.remote },
    createInput: declaredInput
  }, { env });
  assert.equal(prepared.preflight.ready, true, JSON.stringify(prepared.preflight.findings));

  const publicValidation = prepared.preflight.checks.find((entry) =>
    entry.id === 'configuration:capability-catalog').capabilityValidation;
  const applicationCommit = run('git', [
    '--git-dir', fixture.remote, 'rev-parse', 'refs/heads/trunk'
  ]).stdout.trim();
  publicValidation.branch = 'trunk';
  publicValidation.commit = applicationCommit;
  run('git', [
    '--git-dir', fixture.remote, 'update-ref', 'refs/heads/sflow/config', applicationCommit
  ]);

  const resumed = await resumeWorkspaceBootstrap(prepared.bootstrapId, {
    confirmation: prepared.plan.workspace.confirmation,
    env
  });
  assert.equal(resumed.status, 'waiting-user');
  assert.equal(resumed.fault.classification, 'materialization-refused');
  assert.equal(await stat(prepared.plan.workspace.targetPath).catch(() => null), null,
    'a caller-mutated diagnostic cannot redirect the held receipt to bypass moved authority');
});

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

  const reused = await preflightWorkspaceBootstrap(prepared.bootstrapId, { env });
  assert.equal(reused.integrity.sha256, prepared.integrity.sha256,
    'an exact-plan ready preflight is reused rather than rewritten');
  assert.equal(reused.operationBudgets.preflight.used, prepared.operationBudgets.preflight.used);

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

test('bootstrap probes and materialization cannot be redirected away from the exact reviewed URL', async () => {
  const approved = await remoteFixture('trunk');
  const decoy = await remoteFixture('trunk');
  await writeAuthorityMarker(approved, 'trunk', 'approved');
  await writeAuthorityMarker(decoy, 'trunk', 'decoy');
  run('git', ['--git-dir', approved.remote, 'config', 'uploadpack.allowFilter', 'true']);
  run('git', ['--git-dir', decoy.remote, 'config', 'uploadpack.allowFilter', 'true']);
  run('git', ['switch', '-c', 'decoy-only'], { cwd: decoy.source });
  run('git', ['commit', '--allow-empty', '-m', 'decoy-only branch'], { cwd: decoy.source });
  run('git', ['push', decoy.remote, 'decoy-only'], { cwd: decoy.source });

  const approvedUrl = pathToFileURL(approved.remote).href;
  const decoyUrl = pathToFileURL(decoy.remote).href;
  const baseEnv = environment(approved.root);
  const inheritedCount = Number(baseEnv.GIT_CONFIG_COUNT ?? 0);
  const index = Number.isInteger(inheritedCount) && inheritedCount >= 0 ? inheritedCount : 0;
  const countKey = 'GIT_CONFIG_COUNT';
  const configKey = `GIT_CONFIG_KEY_${index}`;
  const configValue = `GIT_CONFIG_VALUE_${index}`;
  const env = {
    ...baseEnv,
    [countKey]: String(index + 1),
    [configKey]: `url.${decoyUrl}.insteadOf`,
    [configValue]: approvedUrl
  };

  const direct = probeGitRemote(approvedUrl, { branch: 'trunk', env });
  assert.equal(direct.ok, true);
  assert.deepEqual(direct.branches, ['trunk'],
    'the synchronous probe must ignore the ambient decoy rewrite');

  const createInput = input(approved.root, approvedUrl, 'trunk');
  createInput.repositories.application.clone = {
    mode: 'blobless-sparse', sparseCone: ['src'], fallback: 'refuse'
  };
  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: approvedUrl }, createInput
  }, { env });
  assert.equal(prepared.preflight.ready, true, JSON.stringify(prepared.preflight.findings));
  const remoteCheck = prepared.preflight.checks.find((entry) => entry.id === 'remote:application');
  assert.equal(remoteCheck.branchCount, 1,
    'the async bootstrap probe must ignore the ambient decoy rewrite');

  const resumed = await resumeWorkspaceBootstrap(prepared.bootstrapId, {
    confirmation: prepared.plan.workspace.confirmation, env
  });
  assert.equal(resumed.status, 'ready');
  const clone = path.join(
    resumed.result.workspace.path,
    resumed.result.workspace.repositories.application.path
  );
  assert.equal(await readFile(path.join(clone, 'AUTHORITY.txt'), 'utf8'), 'approved\n');
  assert.equal(await readFile(path.join(clone, 'src', 'AUTHORITY.txt'), 'utf8'), 'approved source\n',
    'sparse materialization must keep using the frozen transport for lazy blob fetches');
  assert.equal(run('git', ['config', '--local', '--get', 'remote.origin.url'], {
    cwd: clone
  }).stdout.trim(), approvedUrl,
    'the invocation alias must not leak into the durable workspace origin');

  const fetched = await fetchWorkspace(resumed.result.workspace.path, { env });
  assert.equal(fetched.results[0].status, 'fetched');
  assert.equal(run('git', [
    'show-ref', '--verify', '--quiet', 'refs/remotes/origin/decoy-only'
  ], { cwd: clone, allowFailure: true }).status, 1,
    'later workspace refreshes must keep using the stored exact authority');
});

test('capability catalog lazy reads remain bound to the exact reviewed URL', async () => {
  const approved = await remoteFixture('trunk');
  const decoy = await remoteFixture('trunk');
  await ensureConfigurationBranch(approved.remote, {
    capability: {
      capabilityId: 'approved-capability', capabilityName: 'Approved Capability',
      kind: 'delivery', repositoryId: 'application', jiraProject: null, teams: []
    }
  });
  await ensureConfigurationBranch(decoy.remote, {
    capability: {
      capabilityId: 'decoy-capability', capabilityName: 'Decoy Capability',
      kind: 'delivery', repositoryId: 'application', jiraProject: null, teams: []
    }
  });
  run('git', ['--git-dir', approved.remote, 'config', 'uploadpack.allowFilter', 'true']);
  run('git', ['--git-dir', decoy.remote, 'config', 'uploadpack.allowFilter', 'true']);
  const approvedUrl = pathToFileURL(approved.remote).href;
  const decoyUrl = pathToFileURL(decoy.remote).href;
  const inheritedCount = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const index = Number.isInteger(inheritedCount) && inheritedCount >= 0 ? inheritedCount : 0;
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `url.${decoyUrl}.insteadOf`,
    [`GIT_CONFIG_VALUE_${index}`]: approvedUrl
  };
  const cli = path.resolve('bin/singularity-flow.mjs');
  const catalog = JSON.parse(run(process.execPath, [
    cli, 'workspace', 'capabilities', approvedUrl, '--json'
  ], { cwd: approved.root, env }).stdout);
  const approvedCommit = run('git', [
    '--git-dir', approved.remote, 'rev-parse', 'refs/heads/sflow/config'
  ]).stdout.trim();

  assert.equal(catalog.commit, approvedCommit);
  assert.match(JSON.stringify(catalog.capabilities), /Approved Capability/);
  assert.doesNotMatch(JSON.stringify(catalog.capabilities), /Decoy Capability/);
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

test('blocked preflight exposes classified recovery actions without losing the bootstrap', async () => {
  const fixture = await remoteFixture('trunk');
  const env = { ...environment(fixture.root), SINGULARITY_FLOW_NO_NETWORK: '1' };
  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.remote },
    createInput: input(fixture.root, fixture.remote, 'trunk')
  }, { env });

  assert.equal(prepared.status, 'waiting-user');
  assert.equal(prepared.preflight.ready, false);
  assert.ok(prepared.preflight.findings.some((entry) => entry.classification === 'offline'));
  assert.equal(prepared.nextAction.id, 'resume');
  assert.match(prepared.nextAction.command, new RegExp(prepared.bootstrapId));
  assert.ok(prepared.recoveryActions.some((entry) => entry.id === 'inspect'));
  assert.ok(prepared.recoveryActions.some((entry) =>
    entry.finding?.includes('offline') && /Reconnect/.test(entry.instruction)));
  assert.equal((await readWorkspaceBootstrap(prepared.bootstrapId, { env })).bootstrapId,
    prepared.bootstrapId);
});

test('attempt exhaustion has an explicit confirmed retry generation', async () => {
  const fixture = await remoteFixture('trunk');
  const env = { ...environment(fixture.root), SINGULARITY_FLOW_NO_NETWORK: '1' };
  let session = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.remote },
    createInput: input(fixture.root, fixture.remote, 'trunk')
  }, { env });
  session = await preflightWorkspaceBootstrap(session.bootstrapId, { env });
  session = await preflightWorkspaceBootstrap(session.bootstrapId, { env });
  session = await preflightWorkspaceBootstrap(session.bootstrapId, { env });
  assert.equal(session.fault.classification, 'attempt-budget-exhausted');
  assert.equal(session.nextAction.id, 'renew-attempts');
  assert.match(session.nextAction.command, /workspace bootstrap retry/);

  await assert.rejects(retryWorkspaceBootstrap(session.bootstrapId, {
    confirmation: 'wrong', reason: 'network restored', env
  }), (error) => error.code === 'BOOTSTRAP_CONFIRMATION_REQUIRED');
  const renewed = await retryWorkspaceBootstrap(session.bootstrapId, {
    confirmation: 'demo', reason: 'network restored', env
  });
  assert.equal(renewed.recoveryGeneration, 1);
  assert.equal(renewed.operationBudgets.preflight.used, 0);
  assert.equal(renewed.operationBudgets.materialize.used, 0);
  assert.equal(renewed.nextAction.id, 'resume');
  assert.equal(renewed.recoveryAuthorizations.at(-1).proof.planHash, renewed.planHash);
});

test('retry refuses a target that is not provably owned by the preserved bootstrap', async () => {
  const fixture = await remoteFixture('trunk');
  const env = environment(fixture.root);
  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.remote },
    createInput: input(fixture.root, fixture.remote, 'trunk')
  }, { env });
  await mkdir(prepared.plan.workspace.targetPath, { recursive: true });
  await writeFile(path.join(prepared.plan.workspace.targetPath, 'keep.txt'), 'mine\n');
  await preflightWorkspaceBootstrap(prepared.bootstrapId, { env });
  await preflightWorkspaceBootstrap(prepared.bootstrapId, { env });
  await preflightWorkspaceBootstrap(prepared.bootstrapId, { env });

  await assert.rejects(retryWorkspaceBootstrap(prepared.bootstrapId, {
    confirmation: 'demo', reason: 'try again', env
  }), (error) => {
    assert.equal(error.code, 'BOOTSTRAP_RETRY_TARGET_UNPROVEN');
    assert.match(error.details.nextAction.command, /bootstrap status/);
    return true;
  });
  assert.equal(await readFile(path.join(prepared.plan.workspace.targetPath, 'keep.txt'), 'utf8'), 'mine\n');
});

test('retry cannot bypass a bootstrap budget that still has attempts', async () => {
  const fixture = await remoteFixture('trunk');
  const env = { ...environment(fixture.root), SINGULARITY_FLOW_NO_NETWORK: '1' };
  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.remote },
    createInput: input(fixture.root, fixture.remote, 'trunk')
  }, { env });

  await assert.rejects(retryWorkspaceBootstrap(prepared.bootstrapId, {
    confirmation: 'demo', reason: 'skip the remaining attempts', env
  }), (error) => {
    assert.equal(error.code, 'BOOTSTRAP_RETRY_NOT_REQUIRED');
    assert.match(error.details.nextAction.command, /bootstrap resume/);
    return true;
  });
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
  assert.throws(() => probeGitRemote(`ssh://git:${secret}@example.com/acme/repository.git`),
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

test('native Windows path rules reject reserved names and trailing characters without platform simulation', () => {
  const invalid = portableWorkspacePathFindings('C:\\work\\CON\\demo. ', { platform: 'win32' });
  assert.ok(invalid.some((entry) => entry.id === 'machine.path.reserved-device'));
  assert.ok(invalid.some((entry) => entry.id === 'machine.path.trailing-character'));
  assert.deepEqual(portableWorkspacePathFindings('/work/CON/demo. ', { platform: 'linux' }), []);
  const long = portableWorkspacePathFindings(`C:\\${'workspace\\'.repeat(25)}repo`, { platform: 'win32' });
  assert.ok(long.some((entry) => entry.id === 'machine.path.long' && entry.severity === 'warning'));
});

test('enterprise Git diagnostics disclose configuration sources but never their secret values', () => {
  const secretProxy = 'https://employee:secret@example.invalid:8443';
  const secretCaPath = '/private/company/root-ca.pem';
  const diagnostics = enterpriseGitDiagnostics({
    env: { HTTPS_PROXY: secretProxy, GIT_SSL_CAINFO: secretCaPath },
    runCommand: (_command, args) => ({
      status: args.at(-1) === 'http.proxy' ? 0 : 1,
      stdout: args.at(-1) === 'http.proxy' ? secretProxy : secretCaPath
    })
  });
  assert.equal(diagnostics.proxy.configured, true);
  assert.equal(diagnostics.certificateAuthority.configured, true);
  assert.deepEqual(diagnostics.proxy.sources, ['HTTPS_PROXY', 'git:http.proxy']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /employee|secret|root-ca/);
  assert.match(diagnostics.guidance, /never disables TLS/);
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
