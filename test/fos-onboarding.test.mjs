import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { onboardRepository, readFosAttachment, refreshFosAuthority } from '../src/onboard.mjs';
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

test('FOS:AC-005 offline and missing authority refuse without bootstrap', async () => {
  const root = await governedRepository();
  await assert.rejects(() => onboardRepository(root, { authorityLocal: true, offline: true }),
    (error) => error.code === 'AUTHORITY_UNAVAILABLE');
  git(['branch', '-D', 'sflow/config'], root);
  await assert.rejects(() => onboardRepository(root, { authorityLocal: true }),
    (error) => error.code === 'AUTHORITY_NOT_CONFIGURED');
  assert.equal(git(['branch', '--list', 'sflow/config'], root), '');
});

test('FOS:DEFERRED-AC-007 bootstrap is refused before creating attachment state', async () => {
  const root = await governedRepository();
  const result = spawnSync(process.execPath, [cli, 'onboard', root, '--authority-local', '--bootstrap', '--json'], {
    cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_TEST_IDENTITY: 'FOS Test' }
  });
  assert.notEqual(result.status, 0);
  const refusal = JSON.parse(result.stderr);
  assert.equal(refusal.error.code, 'FOS_BOOTSTRAP_UNSUPPORTED');
  assert.equal(await readFosAttachment(root), null);
});

test('FOS:DEFERRED-AC-008 offline reuse stays refused without approved freshness policy and preserves the pin', async () => {
  const root = await governedRepository();
  const attached = await onboardRepository(root, { authorityLocal: true });
  await assert.rejects(() => onboardRepository(root, { authorityLocal: true, offline: true }),
    (error) => error.code === 'AUTHORITY_UNAVAILABLE');
  assert.equal((await readFosAttachment(root)).descriptor.descriptorSha256,
    attached.descriptor.descriptorSha256);
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
