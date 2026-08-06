import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateLedgerDeployment } from '../src/ledger-deployment.mjs';
import { initializeLedger } from '../src/ledger.mjs';
import { run } from '../src/util.mjs';

async function repository() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-ledger-deployment-'));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  await mkdir(root);
  run('git', ['init', '--bare', remote]);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Deployment Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'deployment@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# deployment\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-m', 'root'], { cwd: root });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });
  return { root };
}

const tier0 = { enabled: true, branch: 'state', remote: 'origin', trustTier: 'T0', signing: 'off' };

test('ledger deployment check verifies the published state branch without mutating it', async () => {
  const { root } = await repository();
  await initializeLedger(root, tier0);
  const result = await validateLedgerDeployment(root, tier0);
  assert.equal(result.valid, true);
  assert.equal(result.checks.find((check) => check.id === 'ledger-branch').status, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'protected-branch-policy').status, 'warn');
});

test('high-trust deployment requires explicit server-policy confirmations', async () => {
  const { root } = await repository();
  await initializeLedger(root, tier0);
  run('git', ['config', 'user.signingkey', 'configured-key'], { cwd: root });
  const tier2 = { ...tier0, trustTier: 'T2', signing: 'commit', pinTransport: 'refs' };
  assert.equal((await validateLedgerDeployment(root, tier2)).valid, false);
  const confirmed = await validateLedgerDeployment(root, tier2, {
    confirmations: { protectedBranch: true, pushPolicy: true, pinRetention: true },
    confirmationContext: {
      actor: { name: 'Deployment Tester', email: 'deployment@example.com' },
      authorityGroup: 'release-administrators',
      identityAssurance: 'configured-local'
    },
    record: true
  });
  assert.equal(confirmed.valid, true);
  const stored = JSON.parse(await readFile(path.join(root, confirmed.recordedPath), 'utf8'));
  assert.equal(stored.trustTier, 'T2');
  assert.equal(stored.confirmation.authorityGroup, 'release-administrators');
  assert.match(stored.recordSha256, /^[0-9a-f]{64}$/);
});

test('bare confirmation flags never prove a high-trust server policy', async () => {
  const { root } = await repository();
  await initializeLedger(root, tier0);
  run('git', ['config', 'user.signingkey', 'configured-key'], { cwd: root });
  const result = await validateLedgerDeployment(root, { ...tier0, trustTier: 'T2', signing: 'commit' }, {
    confirmations: { protectedBranch: true, pushPolicy: true }
  });
  assert.equal(result.valid, false);
  assert.equal(result.confirmation, null);
  assert.equal(result.checks.find((check) => check.id === 'protected-branch-policy').status, 'fail');
});
