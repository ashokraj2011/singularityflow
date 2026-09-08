import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrapFosAuthority, FOS_LOCAL_BOOTSTRAP_POLICY_ID,
  onboardRepository, readFosAttachment, refreshFosAuthority
} from '../src/onboard.mjs';
import {
  loadStoryConfigurationSnapshot, resolveRemoteStoryConfigurationAuthority
} from '../src/configuration-branch.mjs';
import { recordSha256 } from '../src/records.mjs';

const cli = new URL('../bin/singularity-flow.mjs', import.meta.url).pathname;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function governedRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-onboard-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'FOS Test'], root);
  git(['config', 'user.email', 'fos@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'initial'], root);
  const initialized = spawnSync(process.execPath, [cli, 'init'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_TEST_IDENTITY: 'FOS Test' }
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  git(['add', '.'], root);
  git(['commit', '-qm', 'governance'], root);
  git(['branch', 'sflow/config'], root);
  return root;
}

async function plainRepository(parent = os.tmpdir(), name = null) {
  const root = name ? path.join(parent, name) : await mkdtemp(path.join(parent, 'sflow-fos-plain-'));
  git(['init', '-q', '-b', 'main', root], parent);
  git(['config', 'user.name', 'FOS Bootstrap'], root);
  git(['config', 'user.email', 'bootstrap@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# plain repository\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'initial'], root);
  return root;
}

async function permitOfflineOnboard(root, overrides = {}) {
  git(['switch', '-q', 'sflow/config'], root);
  const workflow = await readFile(path.join(root, 'singularity/workflow.yml'));
  const authorityPolicySha256 = `sha256:${createHash('sha256').update(workflow).digest('hex')}`;
  const document = {
    schemaVersion: 1,
    offline: {
      policyId: 'bounded-offline-onboard', enabled: true, revoked: false,
      requiredLive: false, operations: ['onboard'], maxAgeSeconds: 3600,
      notAfter: '2099-01-01T00:00:00.000Z', authorityPolicySha256,
      ...overrides
    }
  };
  await writeFile(path.join(root, 'singularity/fos.yml'), `${JSON.stringify(document, null, 2)}\n`);
  git(['add', 'singularity/fos.yml'], root);
  git(['commit', '-qm', 'approve bounded offline onboarding'], root);
  git(['switch', '-q', 'main'], root);
}

test('FOS:AC-001 existing local authority attaches idempotently without changing the checkout', async () => {
  const root = await governedRepository();
  const before = git(['rev-parse', 'HEAD'], root);
  const first = await onboardRepository(root, { authorityLocal: true });
  const second = await onboardRepository(root, { authorityLocal: true });
  assert.equal(first.status, 'attached');
  assert.equal(second.status, 'already-attached', JSON.stringify({
    first: first.descriptor,
    second: second.descriptor
  }, null, 2));
  assert.equal(first.descriptor.descriptorSha256, second.descriptor.descriptorSha256);
  assert.equal(first.receipt.receiptId, second.receipt.receiptId);
  assert.equal(git(['rev-parse', 'HEAD'], root), before);
  assert.equal(git(['status', '--porcelain'], root), '');
  assert.equal((await readFosAttachment(root)).descriptor.verifiedFoldSha256,
    first.descriptor.verifiedFoldSha256);
  assert.deepEqual(first.descriptor.readerRange, { minimum: 1, maximum: 1 });
  assert.equal(first.descriptor.pin.commitOid, first.descriptor.authority.commit);
  assert.equal(first.descriptor.pin.foldDigest, first.descriptor.verifiedFoldSha256);
  assert.equal(first.descriptor.locator.ref, 'refs/heads/sflow/config');
  assert.equal(first.descriptor.effectivePolicyDigest, first.descriptor.policySha256);
  assert.equal(first.descriptor.receiptId, first.receipt.receiptId);
});

test('local authority reuse treats a symlink spelling as the same repository, not a rebind', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-alias-'));
  const root = await plainRepository(parent, 'actual');
  const alias = path.join(parent, 'alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const bootstrapped = await bootstrapFosAuthority(alias, {
    authorityLocal: true, policyId: FOS_LOCAL_BOOTSTRAP_POLICY_ID
  });
  const reused = await onboardRepository(root, { authorityLocal: true });
  assert.equal(bootstrapped.status, 'bootstrapped');
  assert.equal(reused.status, 'already-attached');
  assert.equal(reused.descriptor.authority.locator, await realpath(root));
  await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

test('FOS:AC-005 offline and missing authority refuse without bootstrap', async () => {
  const root = await governedRepository();
  await assert.rejects(() => onboardRepository(root, { authorityLocal: true, offline: true }),
    (error) => error.code === 'AUTHORITY_UNAVAILABLE');
  git(['branch', '-D', 'sflow/config'], root);
  await assert.rejects(() => onboardRepository(root, { authorityLocal: true }),
    (error) => error.code === 'AUTHORITY_NOT_CONFIGURED');
  assert.equal(git(['branch', '--list', 'sflow/config'], root), '');
});

test('FOS:DEFERRED-AC-007 bootstrap without an approved policy is refused before creating attachment state', async () => {
  const root = await governedRepository();
  const result = spawnSync(process.execPath, [cli, 'onboard', root, '--authority-local', '--bootstrap', '--json'], {
    cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_TEST_IDENTITY: 'FOS Test' }
  });
  assert.notEqual(result.status, 0);
  const refusal = JSON.parse(result.stderr);
  assert.equal(refusal.error.code, 'FOS_BOOTSTRAP_OPTIONS_INVALID');
  assert.equal(await readFosAttachment(root), null);
});

test('FOS:AC-007 approved bootstrap creates expected absence once while refusals and concurrent losers preserve authority', async () => {
  const local = await plainRepository();
  const localHead = git(['rev-parse', 'HEAD'], local);
  const localRun = spawnSync(process.execPath, [
    cli, 'onboard', local, '--bootstrap', '--policy', FOS_LOCAL_BOOTSTRAP_POLICY_ID,
    '--authority-local', '--json'
  ], {
    cwd: os.tmpdir(), encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_TEST_IDENTITY: 'FOS Bootstrap' }
  });
  assert.equal(localRun.status, 0, localRun.stderr);
  const localResult = JSON.parse(localRun.stdout).data.result;
  assert.equal(localResult.status, 'bootstrapped');
  assert.equal(localResult.bootstrap.scope, 'unmanaged-local');
  assert.equal(localResult.bootstrap.organizationalAuthority, false);
  assert.equal(git(['rev-parse', 'HEAD'], local), localHead);
  assert.equal(git(['status', '--porcelain'], local), '');
  assert.match(git(['rev-parse', 'refs/heads/sflow/config'], local), /^[a-f0-9]{40,64}$/);

  const interrupted = await plainRepository();
  const interruptedError = new Error('simulated interruption after authority creation');
  interruptedError.code = 'SIMULATED_INTERRUPT';
  await assert.rejects(() => bootstrapFosAuthority(interrupted, {
    authorityLocal: true, policyId: FOS_LOCAL_BOOTSTRAP_POLICY_ID,
    afterAuthorityCreate: async () => { throw interruptedError; }
  }), (error) => error.code === 'SIMULATED_INTERRUPT');
  assert.equal(await readFosAttachment(interrupted), null);
  const resumed = await bootstrapFosAuthority(interrupted, {
    authorityLocal: true, policyId: FOS_LOCAL_BOOTSTRAP_POLICY_ID
  });
  assert.equal(resumed.status, 'bootstrapped');
  assert.equal(resumed.bootstrap.reconciled, true);

  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-bootstrap-race-'));
  const source = await plainRepository(parent, 'source');
  const remote = path.join(parent, 'remote.git');
  const first = path.join(parent, 'first');
  const second = path.join(parent, 'second');
  git(['clone', '-q', '--bare', source, remote], parent);
  git(['clone', '-q', remote, first], parent);
  git(['clone', '-q', remote, second], parent);
  for (const checkout of [first, second]) {
    git(['config', 'user.name', 'FOS Bootstrap'], checkout);
    git(['config', 'user.email', 'bootstrap@example.com'], checkout);
  }
  git(['config', 'user.name', 'FOS Bootstrap Two'], second);
  git(['config', 'user.email', 'bootstrap-two@example.com'], second);
  const policyId = 'approved-organization-bootstrap';
  const resolveBootstrapPolicy = async ({ actorPrincipalId }) => ({
    approved: true, id: policyId, scope: 'organization',
    policySha256: `sha256:${'a'.repeat(64)}`, policyEpoch: 4,
    trustAnchorSha256: `sha256:${'b'.repeat(64)}`, actorPrincipalId,
    organizationalAuthority: true, permitsRemotePublication: true,
    proposedPolicySelfAuthorizing: false
  });
  const kernelAuthorize = async (request) => ({
    disposition: 'allow', ...request, receiptSha256: `sha256:${'c'.repeat(64)}`
  });

  await assert.rejects(() => bootstrapFosAuthority(first, {
    remote: 'origin', publish: true, policyId,
    resolveBootstrapPolicy: async ({ actorPrincipalId }) => ({
      ...(await resolveBootstrapPolicy({ actorPrincipalId })), approved: false
    }),
    kernelAuthorize
  }), (error) => error.code === 'NOT_AUTHORIZED');
  assert.equal(spawnSync('git', [
    '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
  ]).status, 1);

  let arrivals = 0;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const beforeAuthorityCreate = async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await released;
  };
  const attempts = await Promise.allSettled([first, second].map((checkout) => bootstrapFosAuthority(checkout, {
    remote: 'origin', publish: true, policyId,
    resolveBootstrapPolicy, kernelAuthorize, beforeAuthorityCreate
  })));
  assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejected = attempts.find((entry) => entry.status === 'rejected');
  assert.equal(rejected.reason.code, 'AUTHORITY_CONFLICT');
  const winner = git(['--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'], parent);
  assert.match(winner, /^[a-f0-9]{40,64}$/);
  const successful = attempts.find((entry) => entry.status === 'fulfilled').value;
  assert.equal(successful.bootstrap.authorityCommit, winner);

  await rm(local, { recursive: true, force: true });
  await rm(interrupted, { recursive: true, force: true });
  await rm(parent, { recursive: true, force: true });
});

test('FOS:DEFERRED-AC-008 offline reuse stays refused without approved freshness policy and preserves the pin', async () => {
  const root = await governedRepository();
  const attached = await onboardRepository(root, { authorityLocal: true });
  await assert.rejects(() => onboardRepository(root, { authorityLocal: true, offline: true }),
    (error) => error.code === 'AUTHORITY_UNAVAILABLE');
  assert.equal((await readFosAttachment(root)).descriptor.descriptorSha256,
    attached.descriptor.descriptorSha256);
});

test('FOS:AC-008 offline reuse requires complete pinned bytes and a compatible unexpired policy without network access', async () => {
  const authority = await governedRepository();
  await permitOfflineOnboard(authority);
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-offline-'));
  const remote = path.join(parent, 'authority.git');
  const checkout = path.join(parent, 'checkout');
  git(['clone', '-q', '--bare', authority, remote], parent);
  git(['clone', '-q', remote, checkout], parent);
  git(['config', 'user.name', 'Offline FOS'], checkout);
  git(['config', 'user.email', 'offline@example.com'], checkout);
  const attached = await onboardRepository(checkout, { remote: 'origin' });
  const observedAt = Date.parse(attached.descriptor.observedAt);
  await rm(remote, { recursive: true, force: true });

  const reused = await onboardRepository(checkout, {
    remote: 'origin', offline: true, now: new Date(observedAt + 1_000)
  });
  assert.equal(reused.freshness.mode, 'pinned-offline');
  assert.equal(reused.freshness.current, false);
  assert.equal(reused.freshness.latest, false);
  assert.equal(reused.freshness.ageMilliseconds, 1_000);
  assert.equal(reused.freshness.policyId, 'bounded-offline-onboard');

  await assert.rejects(() => onboardRepository(checkout, {
    remote: 'origin', offline: true, now: new Date(observedAt + 3_600_001)
  }), (error) => error.code === 'AUTHORITY_UNAVAILABLE');

  const common = path.resolve(checkout, git(['rev-parse', '--git-common-dir'], checkout));
  const statePath = path.join(common, 'singularity-flow', 'fos', 'attachments',
    attached.descriptor.repository.repositoryInstanceId, 'current.json');
  const damaged = JSON.parse(await readFile(statePath, 'utf8'));
  damaged.offlineSnapshot.assets[0].contentsBase64 = '';
  await writeFile(statePath, `${JSON.stringify(damaged, null, 2)}\n`);
  await assert.rejects(() => onboardRepository(checkout, {
    remote: 'origin', offline: true, now: new Date(observedAt + 2_000)
  }), (error) => error.code === 'AUTHORITY_PIN_INVALID');

  const liveRequired = await governedRepository();
  await permitOfflineOnboard(liveRequired, { requiredLive: true });
  const liveAttached = await onboardRepository(liveRequired, { authorityLocal: true });
  await assert.rejects(() => onboardRepository(liveRequired, {
    authorityLocal: true, offline: true,
    now: new Date(Date.parse(liveAttached.descriptor.observedAt) + 1_000)
  }), (error) => error.code === 'AUTHORITY_UNAVAILABLE');

  await rm(parent, { recursive: true, force: true });
  await rm(authority, { recursive: true, force: true });
  await rm(liveRequired, { recursive: true, force: true });
});

test('FOS:AC-003 ambiguous configured remotes require an explicit choice', async () => {
  const root = await governedRepository();
  git(['remote', 'add', 'one', root], root);
  git(['remote', 'add', 'two', root], root);
  await assert.rejects(() => onboardRepository(root),
    (error) => error.code === 'AUTHORITY_ROUTE_AMBIGUOUS');
});

test('FOS:AC-003 an existing authority cannot be rebound by repeating onboard', async () => {
  const root = await governedRepository();
  await onboardRepository(root, { authorityLocal: true });
  git(['remote', 'add', 'other', root], root);
  await assert.rejects(() => onboardRepository(root, { remote: 'other' }),
    (error) => error.code === 'AUTHORITY_REBIND_REQUIRED');
  assert.equal((await readFosAttachment(root)).descriptor.route.kind, 'local');
});

test('FOS:AC-006 credential-bearing remote literals are refused before persistence', async () => {
  const root = await governedRepository();
  git(['remote', 'add', 'credentialed', 'https://person:secret@example.invalid/repository.git'], root);
  await assert.rejects(() => onboardRepository(root, { remote: 'credentialed' }),
    (error) => error.code === 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
  assert.equal(await readFosAttachment(root), null);
});

test('FOS:AC-004 a recomputed descriptor seal cannot hide an invalid reader contract', async () => {
  const root = await governedRepository();
  const attached = await onboardRepository(root, { authorityLocal: true });
  const common = path.resolve(root, git(['rev-parse', '--git-common-dir'], root));
  const statePath = path.join(common, 'singularity-flow', 'fos', 'attachments',
    attached.descriptor.repository.repositoryInstanceId, 'current.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.descriptor.readerRange.maximum = 99;
  state.descriptor.descriptorSha256 = `sha256:${recordSha256({
    ...state.descriptor, descriptorSha256: null
  })}`;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(() => readFosAttachment(root),
    (error) => error.code === 'AUTHORITY_PIN_INVALID');
});

test('FOS:AC-009 refresh advances the exact pin and retains a completed operation journal', async () => {
  const root = await governedRepository();
  const attached = await onboardRepository(root, { authorityLocal: true });
  git(['switch', '-q', 'sflow/config'], root);
  await writeFile(path.join(root, 'fos-refresh.txt'), 'configuration extension\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'advance authority'], root);
  git(['switch', '-q', 'main'], root);
  const refreshed = await refreshFosAuthority(root);
  assert.equal(refreshed.status, 'refreshed');
  assert.notEqual(refreshed.descriptor.descriptorSha256, attached.descriptor.descriptorSha256);
  assert.equal((await readFosAttachment(root)).descriptor.descriptorSha256,
    refreshed.descriptor.descriptorSha256);
  const journalPath = path.join(git(['rev-parse', '--git-common-dir'], root),
    'singularity-flow', 'fos', 'operations', `${refreshed.operationId}.json`);
  const journal = JSON.parse(await readFile(path.resolve(root, journalPath), 'utf8'));
  assert.equal(journal.phase, 'completed');
});

test('FOS:AC-002 remote-tracking-only onboarding pins one authority revision and refuses a moving ref after one retry', async () => {
  const authority = await governedRepository();
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-remote-pin-'));
  const remote = path.join(parent, 'authority.git');
  const checkout = path.join(parent, 'checkout');
  try {
    git(['switch', '-q', 'sflow/config'], authority);
    await writeFile(path.join(authority, 'authority-only.txt'), 'not reachable from application main\n');
    git(['add', 'authority-only.txt'], authority);
    git(['commit', '-qm', 'authority-only revision'], authority);
    git(['switch', '-q', 'main'], authority);
    git(['clone', '-q', '--bare', authority, remote], parent);
    git(['clone', '-q', '--no-local', '--single-branch', '--branch', 'main', remote, checkout], parent);
    git(['config', 'user.name', 'FOS Consumer'], checkout);
    git(['config', 'user.email', 'consumer@example.com'], checkout);
    const expected = git(['rev-parse', 'refs/heads/sflow/config'], remote);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', `${expected}^{commit}`], {
      cwd: checkout, encoding: 'utf8'
    }).status, 0, 'the application checkout starts with an object-cache miss');

    const attached = await onboardRepository(checkout, { remote: 'origin' });
    assert.equal(attached.descriptor.authority.commit, expected);
    assert.equal(attached.descriptor.authority.sourceCommit, expected);
    assert.equal(git(['branch', '--list', 'sflow/config'], checkout), '',
      'onboarding does not create a local authority branch');

    const selected = await resolveRemoteStoryConfigurationAuthority(remote);
    git(['switch', '-q', 'sflow/config'], authority);
    await writeFile(path.join(authority, 'remote-race.txt'), 'moved after observation\n');
    git(['add', 'remote-race.txt'], authority);
    git(['commit', '-qm', 'move authority after observation'], authority);
    git(['push', '-q', remote, 'sflow/config'], authority);
    await assert.rejects(() => loadStoryConfigurationSnapshot(selected), (error) => {
      assert.equal(error.code, 'STORY_CONFIGURATION_AUTHORITY_STALE');
      assert.equal(error.details.attempts, 2);
      assert.equal(error.details.disposition, 'authority-moved');
      return true;
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('FOS:AC-010 a truncated attachment replacement recovers from the sealed transaction journal', async () => {
  const root = await governedRepository();
  const attached = await onboardRepository(root, { authorityLocal: true });
  const common = path.resolve(root, git(['rev-parse', '--git-common-dir'], root));
  const statePath = path.join(common, 'singularity-flow', 'fos', 'attachments',
    attached.descriptor.repository.repositoryInstanceId, 'current.json');
  await writeFile(statePath, '{"schemaVersion":');
  const recovered = await readFosAttachment(root);
  assert.equal(recovered.recovery.required, true);
  assert.equal(recovered.descriptor.descriptorSha256, attached.descriptor.descriptorSha256);
  const repaired = await onboardRepository(root, { authorityLocal: true });
  assert.equal(repaired.status, 'already-attached');
  const durable = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(durable.descriptor.descriptorSha256, attached.descriptor.descriptorSha256);

  git(['switch', '-q', 'sflow/config'], root);
  await writeFile(path.join(root, 'after-recovery.txt'), 'next complete authority state\n');
  git(['add', 'after-recovery.txt'], root);
  git(['commit', '-qm', 'advance after recovery'], root);
  git(['switch', '-q', 'main'], root);
  const noSpace = new Error('simulated disk full');
  noSpace.code = 'ENOSPC';
  await assert.rejects(() => refreshFosAuthority(root, {
    stateWriter: async () => { throw noSpace; }
  }), (error) => error.code === 'ENOSPC');
  assert.equal((await readFosAttachment(root)).descriptor.descriptorSha256,
    attached.descriptor.descriptorSha256, 'failed replacement preserves the complete old state');
  const resumed = await refreshFosAuthority(root);
  assert.equal(resumed.status, 'refreshed');
  assert.notEqual(resumed.descriptor.descriptorSha256, attached.descriptor.descriptorSha256);
});

test('FOS:PARTIAL-AC-013 policy changes invalidate the old effective policy digest only on explicit refresh', async () => {
  const root = await governedRepository();
  const attached = await onboardRepository(root, { authorityLocal: true });
  git(['switch', '-q', 'sflow/config'], root);
  await writeFile(path.join(root, 'singularity', 'workflow.yml'),
    `${await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8')}\n# FOS policy epoch change\n`);
  git(['add', 'singularity/workflow.yml'], root);
  git(['commit', '-qm', 'change policy epoch'], root);
  git(['switch', '-q', 'main'], root);
  const pinned = await onboardRepository(root, { authorityLocal: true });
  assert.equal(pinned.status, 'already-attached');
  assert.equal(pinned.descriptor.policySha256, attached.descriptor.policySha256);
  const refreshed = await refreshFosAuthority(root);
  assert.notEqual(refreshed.descriptor.policySha256, attached.descriptor.policySha256);
  assert.equal(refreshed.descriptor.effectivePolicyDigest, refreshed.descriptor.policySha256);
});

test('FOS:PARTIAL-AC-017 an advanced authority remains pinned until refresh and then advances exactly once', async () => {
  const root = await governedRepository();
  const attached = await onboardRepository(root, { authorityLocal: true });
  git(['switch', '-q', 'sflow/config'], root);
  await writeFile(path.join(root, 'authority-extension.txt'), 'new reviewed authority bytes\n');
  git(['add', 'authority-extension.txt'], root);
  git(['commit', '-qm', 'advance reviewed authority'], root);
  const advancedCommit = git(['rev-parse', 'HEAD'], root);
  git(['switch', '-q', 'main'], root);
  const stillPinned = await onboardRepository(root, { authorityLocal: true });
  assert.equal(stillPinned.descriptor.authority.commit, attached.descriptor.authority.commit);
  const refreshed = await refreshFosAuthority(root);
  assert.equal(refreshed.descriptor.authority.commit, advancedCommit);
  assert.equal((await refreshFosAuthority(root)).status, 'already-attached');
});

test('FOS:AC-017 a new remote tip never changes an observed pin until explicit refresh', async () => {
  const authority = await governedRepository();
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-observation-'));
  const remote = path.join(parent, 'authority.git');
  const checkout = path.join(parent, 'checkout');
  git(['clone', '-q', '--bare', authority, remote], parent);
  git(['clone', '-q', remote, checkout], parent);
  git(['config', 'user.name', 'FOS Observer'], checkout);
  git(['config', 'user.email', 'observer@example.com'], checkout);

  const attached = await onboardRepository(checkout, { remote: 'origin' });
  assert.equal(attached.freshness.mode, 'observed-online');
  assert.equal(attached.freshness.current, true);
  const oldPin = attached.descriptor.authority.commit;

  git(['switch', '-q', 'sflow/config'], authority);
  await writeFile(path.join(authority, 'remote-advance.txt'), 'new authority generation\n');
  git(['add', 'remote-advance.txt'], authority);
  git(['commit', '-qm', 'advance observed authority'], authority);
  const newPin = git(['rev-parse', 'HEAD'], authority);
  git(['push', '-q', remote, 'sflow/config'], authority);

  const reused = await onboardRepository(checkout, { remote: 'origin' });
  assert.equal(reused.status, 'already-attached');
  assert.equal(reused.descriptor.authority.commit, oldPin);
  assert.deepEqual(reused.freshness, {
    mode: 'pinned-local', observedAt: attached.descriptor.observedAt,
    current: false, latest: false
  });

  const refreshed = await refreshFosAuthority(checkout);
  assert.equal(refreshed.status, 'refreshed');
  assert.equal(refreshed.descriptor.authority.commit, newPin);
  assert.equal(refreshed.freshness.current, true);
  assert.equal(refreshed.freshness.latest, true);
  await rm(parent, { recursive: true, force: true });
  await rm(authority, { recursive: true, force: true });
});

test('FOS:AC-001 public onboard command emits a structured exact pin', async () => {
  const root = await governedRepository();
  const result = spawnSync(process.execPath, [
    cli, 'onboard', root, '--authority-local', '--no-cache', '--json'
  ], {
    cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_TEST_IDENTITY: 'FOS Test' }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.outcome.messageId, 'fos.repository-attached');
  assert.equal(output.data.result.status, 'attached');
  assert.match(output.data.result.descriptor.descriptorSha256, /^sha256:[a-f0-9]{64}$/);
});
