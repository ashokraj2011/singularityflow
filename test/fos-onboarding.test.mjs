import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { onboardRepository, readFosAttachment, refreshFosAuthority } from '../src/onboard.mjs';
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

test('FOS:AC-001 public onboard command emits a structured exact pin', async () => {
  const root = await governedRepository();
  const result = spawnSync(process.execPath, [cli, 'onboard', root, '--authority-local', '--json'], {
    cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_TEST_IDENTITY: 'FOS Test' }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.outcome.messageId, 'fos.repository-attached');
  assert.equal(output.data.result.status, 'attached');
  assert.match(output.data.result.descriptor.descriptorSha256, /^sha256:[a-f0-9]{64}$/);
});
