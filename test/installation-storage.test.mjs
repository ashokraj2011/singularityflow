import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireActivationLease, cleanupInstallationStorage, releaseActivationLease
} from '../scripts/install-staged-artifacts.mjs';

const operation = () => `install-${randomUUID()}`;
const json = (file, value) => writeFile(file, JSON.stringify(value));
const exists = (file) => readFile(file).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-storage-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const installations = path.join(root, 'home', '.singularity-flow', 'installations');
  const transactions = path.join(installations, 'transactions');
  const journal = path.join(installations, 'activation-current.json');
  const checkout = path.join(root, 'workspace', 'source');
  await mkdir(transactions, { recursive: true });
  await mkdir(checkout, { recursive: true });
  await writeFile(path.join(checkout, 'source.txt'), 'workspace source');
  const current = { schemaVersion: 2, artifacts: { tarball: null, vsix: null }, runtimeRoots: { copilot: null } };
  const save = () => json(path.join(installations, 'current.json'), current);
  await save();
  const artifact = async (number) => {
    const digest = number.toString(16).padStart(64, '0');
    const directory = path.join(installations, 'versions', 'sha256', digest);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'singularity-flow.tgz');
    await writeFile(file, `archive ${number}`);
    return { path: file, sha256: `sha256:${digest}` };
  };
  const transaction = async (id = operation()) => {
    const directory = path.join(transactions, id);
    for (const name of ['npm-cache', 'private-cli-candidate', 'private-cli-previous']) {
      await mkdir(path.join(directory, name), { recursive: true });
      await writeFile(path.join(directory, name, 'bytes'), name);
    }
    await writeFile(path.join(directory, 'previous-current-manifest'), '{}');
    return { id, directory };
  };
  const clean = (extra = {}) => cleanupInstallationStorage({ journal, checkout, ...extra });
  return { root, installations, transactions, journal, checkout, current, save, artifact, transaction, clean };
}

test('preview is non-destructive; apply removes only known unreferenced install stores', async (t) => {
  const f = await fixture(t);
  const old = await f.transaction();
  const obsolete = await f.artifact(1);
  const current = await f.artifact(2);
  const rollback = await f.artifact(3);
  f.current.artifacts.tarball = current;
  f.current.rollbackArtifacts = { tarball: rollback };
  await f.save();
  await writeFile(path.join(f.installations, '..', 'workspaces.json'), 'workspace registry');
  const preview = await f.clean();
  assert.equal(preview.applied, false);
  assert.equal(preview.eligible.length, 2);
  assert.equal(preview.removed.length, 0);
  assert.equal(await exists(path.join(old.directory, 'npm-cache', 'bytes')), true);
  const applied = await f.clean({ apply: true });
  assert.equal(applied.removed.length, 2);
  assert.equal(await exists(path.join(old.directory, 'npm-cache', 'bytes')), false);
  assert.equal(await exists(obsolete.path), false);
  assert.equal(await exists(current.path), true);
  assert.equal(await exists(rollback.path), true);
  assert.equal(await readFile(path.join(f.checkout, 'source.txt'), 'utf8'), 'workspace source');
  assert.equal(await readFile(path.join(f.installations, '..', 'workspaces.json'), 'utf8'), 'workspace registry');
  assert.equal((await f.clean({ apply: true })).removed.length, 0, 'cleanup is idempotent');
});

test('repeated successful installs overwrite obsolete runtimes and bound retained artifacts', async (t) => {
  const f = await fixture(t);
  let previous = null;
  for (let count = 1; count <= 12; count += 1) {
    const tx = await f.transaction();
    const artifact = await f.artifact(count);
    f.current.activation = { operationId: tx.id };
    f.current.runtimeRoots.copilot = path.join(tx.directory, 'private-cli-candidate');
    f.current.artifacts.tarball = artifact;
    f.current.rollbackArtifacts = { tarball: previous };
    await f.save();
    await json(f.journal, { schemaVersion: 4, status: 'complete', operationId: tx.id, artifacts: { tarball: artifact } });
    await f.clean({ apply: true });
    assert.equal((await readdir(f.transactions)).length, 1);
    assert.equal(await exists(path.join(tx.directory, 'npm-cache', 'bytes')), false);
    assert.equal(await exists(path.join(tx.directory, 'private-cli-previous', 'bytes')), false);
    assert.equal(await exists(path.join(tx.directory, 'private-cli-candidate', 'bytes')), true);
    assert.ok((await readdir(path.join(f.installations, 'versions', 'sha256'))).length <= 2);
    previous = artifact;
  }
});

for (const status of ['staged', 'activating', 'rolling-back', 'rolled-back', 'rollback-failed']) {
  test(`${status} recovery keeps candidate, rollback, snapshots and indirectly referenced roots`, async (t) => {
    const f = await fixture(t);
    const lease = await acquireActivationLease({ journal: f.journal, checkout: f.checkout });
    t.after(() => releaseActivationLease({ journal: f.journal, ...lease }));
    const pending = await f.transaction(lease.operationId);
    const inherited = await f.transaction();
    const obsolete = await f.transaction();
    const candidate = await f.artifact(10);
    const rollback = await f.artifact(11);
    const old = await f.artifact(12);
    const snapshot = path.join(pending.directory, 'previous-current-manifest');
    await json(snapshot, { runtimeRoots: { copilot: path.join(inherited.directory, 'private-cli-candidate') } });
    await json(f.journal, { schemaVersion: 5, status, operationId: lease.operationId,
      artifacts: { tarball: candidate }, previous: { cli: rollback, manifest: { snapshot } } });
    await f.clean({ apply: true, ...lease });
    assert.equal(await exists(path.join(pending.directory, 'npm-cache', 'bytes')), true);
    assert.equal(await exists(path.join(pending.directory, 'private-cli-previous', 'bytes')), true);
    assert.equal(await exists(path.join(inherited.directory, 'private-cli-candidate', 'bytes')), true);
    assert.equal(await exists(path.join(obsolete.directory, 'npm-cache', 'bytes')), false);
    assert.equal(await exists(candidate.path), true);
    assert.equal(await exists(rollback.path), true);
    assert.equal(await exists(old.path), false);
  });
}

test('partial installs preserve inherited Copilot roots and legacy current transactions', async (t) => {
  const f = await fixture(t);
  const inherited = await f.transaction();
  f.current.runtimeRoots.copilot = path.join(inherited.directory, 'private-cli-candidate');
  await f.save();
  await f.clean({ apply: true });
  assert.equal(await exists(path.join(inherited.directory, 'private-cli-candidate', 'bytes')), true);
  delete f.current.runtimeRoots;
  f.current.activation = { operationId: inherited.id };
  f.current.status = 'complete';
  await f.save();
  await f.clean({ apply: true });
  assert.equal(await exists(path.join(inherited.directory, 'private-cli-previous', 'bytes')), true);
});

test('legacy partial upgrades retain the older full install serving Copilot until replacement', async (t) => {
  const f = await fixture(t);
  const full = await f.transaction();
  const partial = await f.transaction();
  await json(path.join(partial.directory, 'previous-current-manifest'), {
    schemaVersion: 2, status: 'complete', activation: { operationId: full.id }
  });
  f.current.status = 'partial-by-request';
  f.current.activation = { operationId: partial.id };
  f.current.runtimeRoots = { copilot: path.join(partial.directory, 'private-cli-candidate'), legacyCopilot: true };
  await f.save();
  await f.clean({ apply: true });
  assert.equal(await exists(path.join(full.directory, 'private-cli-candidate', 'bytes')), true);
  const replacement = await f.transaction();
  f.current.status = 'complete';
  f.current.activation = { operationId: replacement.id };
  f.current.runtimeRoots = { copilot: path.join(replacement.directory, 'private-cli-candidate'), legacyCopilot: false };
  await f.save();
  await f.clean({ apply: true });
  assert.equal(await exists(path.join(full.directory, 'private-cli-candidate', 'bytes')), false);
  assert.equal(await exists(path.join(partial.directory, 'private-cli-candidate', 'bytes')), false);
});

test('cleanup cannot compete with a live installer or release its lease', async (t) => {
  const f = await fixture(t);
  const lease = await acquireActivationLease({ journal: f.journal, checkout: f.checkout });
  t.after(() => releaseActivationLease({ journal: f.journal, ...lease }));
  const old = await f.transaction();
  await assert.rejects(f.clean({ apply: true }), /another installer operation.*active/u);
  assert.equal(await exists(path.join(old.directory, 'npm-cache', 'bytes')), true);
  assert.equal(await exists(path.join(`${f.journal}.lock`, 'owner.json')), true);
});

for (const name of ['distribution-install-pending.json', 'uninstall-pending.json']) {
  test(`${name} defers GC rather than discarding other product recovery`, async (t) => {
    const f = await fixture(t);
    const old = await f.transaction();
    await writeFile(path.join(f.installations, name), '{}');
    assert.equal((await f.clean({ apply: true })).removed.length, 0);
    assert.equal(await exists(path.join(old.directory, 'npm-cache', 'bytes')), true);
  });
}

test('unknown contents and symlinks/junctions are retained, never followed into source', async (t) => {
  const f = await fixture(t);
  const unknown = await f.transaction();
  await writeFile(path.join(unknown.directory, 'personal.txt'), 'not owned by installer');
  const linked = path.join(f.transactions, operation());
  await symlink(f.checkout, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const r = await f.clean({ apply: true });
  assert.equal(r.removed.length, 0);
  assert.equal(r.preserved.length, 2);
  assert.equal(await readFile(path.join(f.checkout, 'source.txt'), 'utf8'), 'workspace source');
  assert.equal(await exists(path.join(unknown.directory, 'personal.txt')), true);
});

test('a linked transactions parent cannot redirect cleanup outside installation storage', async (t) => {
  const f = await fixture(t);
  await rm(f.transactions, { recursive: true });
  await symlink(f.checkout, f.transactions, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.clean({ apply: true })).removed.length, 0);
  assert.equal(await readFile(path.join(f.checkout, 'source.txt'), 'utf8'), 'workspace source');
});

for (const data of ['{not json', JSON.stringify({ schemaVersion: 99 }), JSON.stringify({ schemaVersion: 2 }),
  JSON.stringify({ schemaVersion: 2, artifacts: {} }),
  JSON.stringify({ schemaVersion: 2, artifacts: { tarball: { path: '/not-owned', sha256: 'bad' }, vsix: null } })]) {
  test(`malformed/future current receipt preserves all storage: ${data}`, async (t) => {
    const f = await fixture(t);
    const old = await f.transaction();
    await writeFile(path.join(f.installations, 'current.json'), data);
    await assert.rejects(f.clean({ apply: true }));
    assert.equal(await exists(path.join(old.directory, 'npm-cache', 'bytes')), true);
    assert.equal(await exists(path.join(`${f.journal}.lock`, 'owner.json')), false);
  });
}

test('interrupted cleanup tombstones can be retried without touching unknown names', async (t) => {
  const f = await fixture(t);
  const tx = await f.transaction();
  const retired = path.join(f.transactions, `.retired-install-${randomUUID()}`);
  const { rename } = await import('node:fs/promises');
  await rename(tx.directory, retired);
  await mkdir(path.join(f.transactions, 'personal-repo'));
  assert.equal((await f.clean({ apply: true })).removed.length, 1);
  assert.deepEqual(await readdir(f.transactions), ['personal-repo']);
});

test('broad roots and non-managed layouts are rejected before deletion', async (t) => {
  const f = await fixture(t);
  await assert.rejects(cleanupInstallationStorage({
    journal: path.join(f.checkout, 'activation-current.json'), checkout: f.checkout, apply: true
  }), /exact .*layout/u);
  assert.equal(await readFile(path.join(f.checkout, 'source.txt'), 'utf8'), 'workspace source');
});

test('future recovery formats and invalid runtime references preserve all bytes', async (t) => {
  const f = await fixture(t);
  const old = await f.transaction();
  await json(f.journal, { schemaVersion: 99, status: 'complete', operationId: operation() });
  await assert.rejects(f.clean({ apply: true }), /unrecognized activation/u);
  await rm(f.journal);
  f.current.runtimeRoots = {};
  await f.save();
  await assert.rejects(f.clean({ apply: true }), /runtime references/u);
  assert.equal(await exists(path.join(old.directory, 'npm-cache', 'bytes')), true);
});

test('Windows exclusive file locks defer cleanup and allow a later retry', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const tx = await f.transaction();
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$f = [IO.File]::Open($env:SF_TEST_LOCK_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None); [Console]::WriteLine("locked"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()'
  ], { env: { ...process.env, SF_TEST_LOCK_PATH: path.join(tx.directory, 'npm-cache', 'bytes') } });
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('exclusive lock was not established')), 20_000);
    holder.once('error', (error) => { clearTimeout(timer); reject(error); });
    holder.stdout.on('data', (bytes) => {
      if (bytes.toString().includes('locked')) { clearTimeout(timer); resolve(); }
    });
    holder.once('exit', (code) => { clearTimeout(timer); if (code) reject(new Error(`lock holder exited ${code}`)); });
  });
  const result = await f.clean({ apply: true });
  assert.equal(result.removed.length, 0);
  assert.ok(result.warnings.length > 0);
  await new Promise((resolve) => { holder.once('exit', resolve); holder.stdin.end('\n'); });
  assert.equal((await f.clean({ apply: true })).removed.length, 1);
});
