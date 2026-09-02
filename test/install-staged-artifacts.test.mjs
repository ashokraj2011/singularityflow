import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acquireActivationLease,
  createActivationJournal,
  heartbeatActivationLease,
  inspectNpmTarball,
  inspectVsix,
  loadActivationRecovery,
  releaseActivationLease,
  resetActivationJournalForRetry,
  updateActivationJournal,
  verifyStagedCli
} from '../scripts/install-staged-artifacts.mjs';

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function npmTarball(manifest) {
  const body = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([
    tarHeader('package/package.json', body.length), body, padding, Buffer.alloc(1024)
  ]));
}

function storedZip(name, body) {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const directory = Buffer.concat([central, filename]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(local.length + filename.length + body.length, 16);
  return Buffer.concat([local, filename, body, directory, eocd]);
}

async function fixture(version = '0.9.0') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-staged-install-'));
  const journal = path.join(root, 'activation.json');
  const installer = path.join(root, 'install.sh');
  const tarball = path.join(root, 'singularity-flow.tgz');
  const vsix = path.join(root, 'singularity-flow.vsix');
  await mkdir(path.join(root, 'checkout'));
  await writeFile(installer, '#!/usr/bin/env bash\n');
  await writeFile(tarball, npmTarball({ name: 'singularity-flow', version }));
  await writeFile(vsix, storedZip('extension/package.json', Buffer.from(JSON.stringify({
    publisher: 'singularityflow', name: 'singularity-flow-vscode', version
  }))));
  const checkout = path.join(root, 'checkout');
  const lease = await acquireActivationLease({ journal, checkout, mode: 'create' });
  return { root, journal, installer, tarball, vsix, checkout, version, lease };
}

const leaseArguments = (item) => ({
  operationId: item.lease.operationId,
  ownerPid: item.lease.ownerPid
});
const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/install-staged-artifacts.mjs');

test('staged install journal binds regular npm and VSIX package identities, bytes, modes, and prior identities', async () => {
  const item = await fixture();
  assert.deepEqual(await inspectNpmTarball(item.tarball), {
    path: item.tarball,
    sha256: (await inspectNpmTarball(item.tarball)).sha256,
    package: 'singularity-flow',
    version: item.version
  });
  assert.equal((await inspectVsix(item.vsix)).extensionId, 'singularityflow.singularity-flow-vscode');
  const record = await createActivationJournal({
    journal: item.journal,
    checkout: item.checkout,
    registry: 'https://registry.example.test/npm',
    version: item.version,
    mode: {
      cliOnly: false, vscodeOnly: false, skipVscode: false, skipCopilot: true,
      telemetry: false, workspaceRefresh: false
    },
    tarball: item.tarball,
    vsix: item.vsix,
    previous: { cliVersion: '0.8.0', vscodeVersion: '0.8.0' },
    recoveryCommand: `${item.installer} --from-staged-artifacts`,
    installer: item.installer,
    ...leaseArguments(item)
  });
  assert.equal(record.schemaVersion, 5);
  assert.equal(record.revision, 1);
  assert.match(record.operationId, /^install-/u);
  assert.match(record.artifacts.tarball.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(record.artifacts.vsix.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(record.artifacts.tarball.path, item.tarball);
  assert.notEqual(record.artifacts.vsix.path, item.vsix);
  assert.match(record.artifacts.tarball.path, /versions[/\\]sha256[/\\][a-f0-9]{64}[/\\]singularity-flow\.tgz$/u);
  assert.match(record.artifacts.vsix.path, /versions[/\\]sha256[/\\][a-f0-9]{64}[/\\]singularity-flow\.vsix$/u);
  assert.deepEqual(await readFile(record.artifacts.tarball.path), await readFile(item.tarball));
  assert.deepEqual(await readFile(record.artifacts.vsix.path), await readFile(item.vsix));
  if (process.platform !== 'win32') {
    assert.equal((await stat(record.artifacts.tarball.path)).mode & 0o777, 0o600);
    assert.equal((await stat(record.artifacts.vsix.path)).mode & 0o777, 0o600);
  }
  assert.equal(record.previous.cliPresent, false);
  assert.equal(record.previous.vscodePresent, false);
  assert.equal(record.previous.copilotPresent, false);
  assert.equal(record.previous.cli, null);
  assert.equal(record.previous.vscode, null);
  assert.deepEqual(record.previous.manifest, {
    target: path.join(item.root, 'current.json'), existed: false, snapshot: null, sha256: null, mode: null
  });
  assert.equal(record.registry, 'https://registry.example.test/npm/');
  await updateActivationJournal(item.journal, {
    status: 'activating', surface: 'Installing the VS Code extension',
    transitionSurface: 'vscode', transitionState: 'applying',
    failureStep: 'Installing the VS Code extension', expectedRevision: record.revision,
    ...leaseArguments(item)
  });
  const loaded = await loadActivationRecovery({
    journal: item.journal, checkout: item.checkout, installer: item.installer,
    ...leaseArguments(item)
  });
  assert.equal(loaded.status, 'activating');
  assert.deepEqual(loaded.completedSurfaces, []);
  assert.equal(loaded.failureStep, 'Installing the VS Code extension');
  assert.equal(loaded.revision, 2);
});

test('prior managed surfaces require exact current.json rollback artifacts before activation is admitted', async () => {
  const missing = await fixture();
  await assert.rejects(createActivationJournal({
    journal: missing.journal,
    checkout: missing.checkout,
    registry: 'https://registry.example.test/npm/',
    version: missing.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: missing.tarball,
    previousObserved: { cliVersion: missing.version, vscodeVersion: null, copilotPresent: false },
    currentManifest: path.join(missing.root, 'current.json'),
    recoveryCommand: `${missing.installer} --from-staged-artifacts`,
    installer: missing.installer,
    ...leaseArguments(missing)
  }), /installed tarball surface has no managed current\.json rollback receipt/u);

  const item = await fixture();
  const sourceTarball = await inspectNpmTarball(item.tarball);
  const sourceVsix = await inspectVsix(item.vsix);
  const retainedTarball = path.join(
    item.root, 'versions', 'sha256', sourceTarball.sha256.slice('sha256:'.length), 'singularity-flow.tgz'
  );
  const retainedVsix = path.join(
    item.root, 'versions', 'sha256', sourceVsix.sha256.slice('sha256:'.length), 'singularity-flow.vsix'
  );
  await mkdir(path.dirname(retainedTarball), { recursive: true });
  await mkdir(path.dirname(retainedVsix), { recursive: true });
  await writeFile(retainedTarball, await readFile(item.tarball), { mode: 0o600 });
  await writeFile(retainedVsix, await readFile(item.vsix), { mode: 0o600 });
  const currentManifest = path.join(item.root, 'current.json');
  await writeFile(currentManifest, `${JSON.stringify({
    schemaVersion: 2,
    artifacts: {
      tarball: { ...sourceTarball, path: retainedTarball },
      vsix: { ...sourceVsix, path: retainedVsix }
    }
  })}\n`, { mode: 0o640 });
  const telemetry = path.join(item.root, 'copilot-otel.sh');
  await writeFile(telemetry, 'prior telemetry\n', { mode: 0o600 });
  const record = await createActivationJournal({
    journal: item.journal,
    checkout: item.checkout,
    registry: 'https://registry.example.test/npm/',
    version: item.version,
    mode: {
      cliOnly: false, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: true, workspaceRefresh: false
    },
    tarball: item.tarball,
    vsix: item.vsix,
    previousObserved: {
      cliVersion: item.version, vscodeVersion: item.version, copilotPresent: true
    },
    currentManifest,
    telemetryEnvFile: telemetry,
    recoveryCommand: `${item.installer} --from-staged-artifacts`,
    installer: item.installer,
    ...leaseArguments(item)
  });
  assert.equal(record.previous.cli.path, retainedTarball);
  assert.equal(record.previous.vscode.path, retainedVsix);
  assert.equal(record.previous.copilotPresent, true);
  assert.equal(record.previous.manifest.existed, true);
  assert.equal(record.previous.manifest.mode, 0o640);
  assert.equal(record.previous.telemetry.envFile.existed, true);
  assert.equal(record.previous.telemetry.envFile.mode, 0o600);
  assert.deepEqual(await readFile(record.previous.manifest.snapshot), await readFile(currentManifest));
  await writeFile(retainedTarball, Buffer.from('tampered'));
  await assert.rejects(loadActivationRecovery({
    journal: item.journal, checkout: item.checkout, installer: item.installer,
    ...leaseArguments(item)
  }), /previous npm tarball|previous tarball|bounded gzip/u);
});

test('surface transitions persist verified rollback and reset the same operation for retry', async () => {
  const item = await fixture();
  let record = await createActivationJournal({
    journal: item.journal,
    checkout: item.checkout,
    registry: 'https://registry.example.test/npm/',
    version: item.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: item.tarball,
    recoveryCommand: `${item.installer} --from-staged-artifacts`,
    installer: item.installer,
    ...leaseArguments(item)
  });
  const mutate = async (change) => {
    record = await updateActivationJournal(item.journal, {
      ...change, expectedRevision: record.revision, ...leaseArguments(item)
    });
  };
  await mutate({ status: 'activating', surface: 'cli-started', transitionSurface: 'cli', transitionState: 'applying' });
  await mutate({ status: 'rolling-back', surface: 'rollback-started' });
  await mutate({ status: 'rolling-back', surface: 'cli-restoring', transitionSurface: 'cli', transitionState: 'restoring' });
  await mutate({ status: 'rolling-back', surface: 'cli-restored', transitionSurface: 'cli', transitionState: 'restored' });
  await mutate({ status: 'rolled-back', surface: 'rollback-complete' });
  assert.equal(record.surfaceStates.cli, 'restored');
  const reset = await resetActivationJournalForRetry(item.journal, {
    expectedRevision: record.revision, ...leaseArguments(item)
  });
  assert.equal(reset.operationId, record.operationId);
  assert.equal(reset.status, 'staged');
  assert.equal(reset.surfaceStates.cli, 'pending');
  assert.equal(reset.surfaceStates.manifest, 'pending');
});

test('staged recovery ignores mutable source artifacts and refuses retained tampering, installer drift, version mismatch, and symlinks', async () => {
  const item = await fixture();
  const create = (overrides = {}) => createActivationJournal({
    journal: item.journal,
    checkout: item.checkout,
    registry: 'https://registry.example.test/npm/',
    version: item.version,
    mode: {
      cliOnly: false, vscodeOnly: false, skipVscode: false, skipCopilot: true,
      telemetry: false, workspaceRefresh: false
    },
    tarball: item.tarball,
    vsix: item.vsix,
    recoveryCommand: `${item.installer} --from-staged-artifacts`,
    installer: item.installer,
    ...leaseArguments(item),
    ...overrides
  });
  const retained = await create();
  await writeFile(item.tarball, Buffer.from('changed'));
  const sourceChanged = await loadActivationRecovery({
    journal: item.journal, checkout: item.checkout, installer: item.installer,
    ...leaseArguments(item)
  });
  assert.equal(sourceChanged.artifacts.tarball.path, retained.artifacts.tarball.path);
  await writeFile(retained.artifacts.tarball.path, Buffer.from('changed retained bytes'));
  await assert.rejects(
    loadActivationRecovery({
      journal: item.journal, checkout: item.checkout, installer: item.installer,
      ...leaseArguments(item)
    }),
    /npm tarball|tarball bytes|bounded gzip/u
  );

  const versionMismatch = await fixture('1.0.0');
  await assert.rejects(createActivationJournal({
    journal: versionMismatch.journal,
    checkout: versionMismatch.checkout,
    registry: 'https://registry.example.test/npm/',
    version: '2.0.0',
    mode: {
      cliOnly: false, vscodeOnly: false, skipVscode: false, skipCopilot: true,
      telemetry: false, workspaceRefresh: false
    },
    tarball: versionMismatch.tarball,
    vsix: versionMismatch.vsix,
    recoveryCommand: `${versionMismatch.installer} --from-staged-artifacts`,
    installer: versionMismatch.installer,
    ...leaseArguments(versionMismatch)
  }), /version 1\.0\.0 does not match product version 2\.0\.0/u);

  const linked = await fixture();
  const link = path.join(linked.root, 'linked.tgz');
  await symlink(linked.tarball, link);
  await assert.rejects(createActivationJournal({
    journal: linked.journal,
    checkout: linked.checkout,
    registry: 'https://registry.example.test/npm/',
    version: linked.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: link,
    recoveryCommand: `${linked.installer} --from-staged-artifacts`,
    installer: linked.installer,
    ...leaseArguments(linked)
  }), /not a regular, non-symlink file/u);

  const installerChanged = await fixture();
  await createActivationJournal({
    journal: installerChanged.journal,
    checkout: installerChanged.checkout,
    registry: 'https://registry.example.test/npm/',
    version: installerChanged.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: installerChanged.tarball,
    recoveryCommand: `${installerChanged.installer} --from-staged-artifacts`,
    installer: installerChanged.installer,
    ...leaseArguments(installerChanged)
  });
  await writeFile(installerChanged.installer, '# changed\n');
  await assert.rejects(loadActivationRecovery({
    journal: installerChanged.journal,
    checkout: installerChanged.checkout,
    installer: installerChanged.installer,
    ...leaseArguments(installerChanged)
  }), /installer or validator bytes changed/u);
});

test('retained artifact paths cannot escape the journal store or be replaced by symlinks', async () => {
  const escaped = await fixture();
  const escapedRecord = await createActivationJournal({
    journal: escaped.journal,
    checkout: escaped.checkout,
    registry: 'https://registry.example.test/npm/',
    version: escaped.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: escaped.tarball,
    recoveryCommand: `${escaped.installer} --from-staged-artifacts`,
    installer: escaped.installer,
    ...leaseArguments(escaped)
  });
  const journal = JSON.parse(await readFile(escaped.journal, 'utf8'));
  journal.artifacts.tarball.path = escaped.tarball;
  await writeFile(escaped.journal, `${JSON.stringify(journal, null, 2)}\n`);
  await assert.rejects(loadActivationRecovery({
    journal: escaped.journal, checkout: escaped.checkout, installer: escaped.installer,
    ...leaseArguments(escaped)
  }), /outside its journal-owned content-addressed retention directory/u);

  const linked = await fixture();
  const linkedRecord = await createActivationJournal({
    journal: linked.journal,
    checkout: linked.checkout,
    registry: 'https://registry.example.test/npm/',
    version: linked.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: linked.tarball,
    recoveryCommand: `${linked.installer} --from-staged-artifacts`,
    installer: linked.installer,
    ...leaseArguments(linked)
  });
  await rm(linkedRecord.artifacts.tarball.path);
  await symlink(linked.tarball, linkedRecord.artifacts.tarball.path);
  await assert.rejects(loadActivationRecovery({
    journal: linked.journal, checkout: linked.checkout, installer: linked.installer,
    ...leaseArguments(linked)
  }), /not a regular, non-symlink file/u);

  const linkedAncestor = await fixture();
  await createActivationJournal({
    journal: linkedAncestor.journal,
    checkout: linkedAncestor.checkout,
    registry: 'https://registry.example.test/npm/',
    version: linkedAncestor.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: linkedAncestor.tarball,
    recoveryCommand: `${linkedAncestor.installer} --from-staged-artifacts`,
    installer: linkedAncestor.installer,
    ...leaseArguments(linkedAncestor)
  });
  const versions = path.join(linkedAncestor.root, 'versions');
  const movedVersions = path.join(linkedAncestor.root, 'versions-real');
  await rename(versions, movedVersions);
  await symlink(movedVersions, versions, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadActivationRecovery({
    journal: linkedAncestor.journal,
    checkout: linkedAncestor.checkout,
    installer: linkedAncestor.installer,
    ...leaseArguments(linkedAncestor)
  }), /retained artifact directory is not a regular, non-symlink directory/u);

  const poisonedStore = await fixture();
  const redirected = path.join(poisonedStore.root, 'redirected');
  await mkdir(redirected);
  await symlink(
    redirected,
    path.join(poisonedStore.root, 'versions'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(createActivationJournal({
    journal: poisonedStore.journal,
    checkout: poisonedStore.checkout,
    registry: 'https://registry.example.test/npm/',
    version: poisonedStore.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: poisonedStore.tarball,
    recoveryCommand: `${poisonedStore.installer} --from-staged-artifacts`,
    installer: poisonedStore.installer,
    ...leaseArguments(poisonedStore)
  }), /retained artifact directory is not a regular, non-symlink directory/u);

  assert.match(escapedRecord.artifacts.tarball.path, /versions/u);
});

test('complete activation journal is not a reusable arbitrary installer input', async () => {
  const item = await fixture();
  await createActivationJournal({
    journal: item.journal,
    checkout: item.checkout,
    registry: 'https://registry.example.test/npm/',
    version: item.version,
    mode: {
      cliOnly: false, vscodeOnly: true, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    vsix: item.vsix,
    recoveryCommand: `${item.installer} --from-staged-artifacts`,
    installer: item.installer,
    ...leaseArguments(item)
  });
  let revision = 1;
  for (const update of [
    { status: 'activating', surface: 'vscode-started', transitionSurface: 'vscode', transitionState: 'applying' },
    { status: 'activating', surface: 'vscode', completed: 'vscode', transitionSurface: 'vscode', transitionState: 'applied' },
    { status: 'activating', surface: 'manifest-started', transitionSurface: 'manifest', transitionState: 'applying' },
    { status: 'activating', surface: 'manifest', completed: 'manifest', transitionSurface: 'manifest', transitionState: 'applied' },
    { status: 'complete', surface: 'complete' }
  ]) {
    const updated = await updateActivationJournal(item.journal, {
      ...update, expectedRevision: revision, ...leaseArguments(item)
    });
    revision = updated.revision;
  }
  await assert.rejects(loadActivationRecovery({
    journal: item.journal, checkout: item.checkout, installer: item.installer,
    ...leaseArguments(item)
  }), /already complete/u);
  const persisted = JSON.parse(await readFile(item.journal, 'utf8'));
  assert.deepEqual(persisted.completedSurfaces, ['vscode', 'manifest']);
});

test('isolated staged CLI verification binds package identity and rejects symlinked executable paths', async () => {
  const item = await fixture();
  const prefix = path.join(item.root, 'prefix');
  const packageDirectory = path.join(prefix, 'node_modules', 'singularity-flow');
  await mkdir(path.join(packageDirectory, 'bin'), { recursive: true });
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'singularity-flow', version: item.version
  }));
  const executable = path.join(packageDirectory, 'bin', 'singularity-flow.mjs');
  await writeFile(executable, `console.log(${JSON.stringify(item.version)});\n`);
  assert.deepEqual(await verifyStagedCli({ prefix, version: item.version }), {
    prefix,
    executable,
    version: item.version
  });
  const replacement = path.join(item.root, 'replacement.mjs');
  await writeFile(replacement, `console.log(${JSON.stringify(item.version)});\n`);
  await rm(executable);
  await symlink(replacement, executable);
  await assert.rejects(
    verifyStagedCli({ prefix, version: item.version }),
    /not a regular, non-symlink file/u
  );
});

test('activation lease excludes a concurrent installer and safely reclaims a dead owner', async () => {
  const item = await fixture();
  const contender = spawnSync(process.execPath, [
    helperPath, 'lease-acquire', '--journal', item.journal, '--checkout', item.checkout,
    '--mode', 'create'
  ], { encoding: 'utf8' });
  assert.notEqual(contender.status, 0);
  assert.match(contender.stderr, /another installer operation .* is active/u);
  await assert.rejects(
    acquireActivationLease({ journal: item.journal, checkout: item.checkout, mode: 'create' }),
    /another installer operation .* is active/u
  );
  await assert.rejects(
    releaseActivationLease({
      journal: item.journal,
      operationId: `install-${randomUUID()}`,
      ownerPid: item.lease.ownerPid
    }),
    /refusing to release another installer operation/u
  );
  assert.equal(await releaseActivationLease({
    journal: item.journal, ...leaseArguments(item)
  }), true);

  const exitedOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(Number.isSafeInteger(exitedOwner.pid) && exitedOwner.pid > 0);
  const leaseDirectory = `${item.journal}.lock`;
  const staleOperationId = `install-${randomUUID()}`;
  await mkdir(leaseDirectory, { mode: 0o700 });
  await writeFile(path.join(leaseDirectory, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    format: 'singularity-flow-install-activation-lease/v1',
    operationId: staleOperationId,
    ownerPid: exitedOwner.pid,
    checkout: item.checkout,
    acquiredAt: new Date(0).toISOString()
  })}\n`);
  await assert.rejects(heartbeatActivationLease({
    journal: item.journal, operationId: staleOperationId, ownerPid: exitedOwner.pid
  }), /activation lease owner is no longer alive/u);
  await utimes(leaseDirectory, new Date(0), new Date(0));
  const replacement = await acquireActivationLease({
    journal: item.journal, checkout: item.checkout, mode: 'create'
  });
  assert.notEqual(replacement.operationId, item.lease.operationId);
  assert.deepEqual(await heartbeatActivationLease({ journal: item.journal, ...replacement }), {
    operationId: replacement.operationId,
    ownerPid: replacement.ownerPid
  });
  assert.equal(await releaseActivationLease({ journal: item.journal, ...replacement }), true);

  await mkdir(leaseDirectory, { mode: 0o700 });
  await assert.rejects(
    acquireActivationLease({ journal: item.journal, checkout: item.checkout, mode: 'create' }),
    /another installer is initializing the activation lease/u
  );
  await rm(leaseDirectory, { recursive: true });
});

test('a normal install cannot supersede an incomplete activation journal', async () => {
  const item = await fixture();
  const record = await createActivationJournal({
    journal: item.journal,
    checkout: item.checkout,
    registry: 'https://registry.example.test/npm/',
    version: item.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: item.tarball,
    recoveryCommand: `${item.installer} --from-staged-artifacts`,
    installer: item.installer,
    ...leaseArguments(item)
  });
  assert.equal(await releaseActivationLease({ journal: item.journal, ...leaseArguments(item) }), true);

  await assert.rejects(
    acquireActivationLease({ journal: item.journal, checkout: item.checkout, mode: 'create' }),
    new RegExp(`activation journal '${record.operationId}'.*staged.*--from-staged-artifacts`, 'u')
  );
  const recovery = await acquireActivationLease({
    journal: item.journal, checkout: item.checkout, mode: 'resume'
  });
  assert.equal(recovery.operationId, record.operationId);
  assert.equal(await releaseActivationLease({ journal: item.journal, ...recovery }), true);
});

test('activation journal updates use an operation-bound revision CAS under contention', async () => {
  const item = await fixture();
  const record = await createActivationJournal({
    journal: item.journal,
    checkout: item.checkout,
    registry: 'https://registry.example.test/npm/',
    version: item.version,
    mode: {
      cliOnly: true, vscodeOnly: false, skipVscode: false, skipCopilot: false,
      telemetry: false, workspaceRefresh: false
    },
    tarball: item.tarball,
    recoveryCommand: `${item.installer} --from-staged-artifacts`,
    installer: item.installer,
    ...leaseArguments(item)
  });
  const update = (surface) => updateActivationJournal(item.journal, {
    status: 'activating', surface, completed: surface, expectedRevision: record.revision,
    ...leaseArguments(item)
  });
  const results = await Promise.allSettled([update('cli'), update('vscode')]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.match(String(results.find(({ status }) => status === 'rejected').reason?.message),
    /activation journal revision changed; expected 1, found 2/u);
  const persisted = JSON.parse(await readFile(item.journal, 'utf8'));
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.completedSurfaces.length, 1);
  await assert.rejects(updateActivationJournal(item.journal, {
    status: 'rolling-back', surface: 'stale', expectedRevision: 1, ...leaseArguments(item)
  }), /activation journal revision changed; expected 1, found 2/u);
  const unchanged = JSON.parse(await readFile(item.journal, 'utf8'));
  assert.equal(unchanged.revision, 2);
  assert.equal(unchanged.surface, persisted.surface);
});
