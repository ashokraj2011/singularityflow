import { createHash, generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISTRIBUTION_OPERATOR_DOCUMENTATION, DISTRIBUTION_OPERATOR_SCRIPTS
} from '../../src/distribution-bundle.mjs';
import { signReleaseArtifactReceipt } from '../../src/release-artifact-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

export function fileSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function distributionFixture({
  version = '9.8.7',
  vsixVersion = version,
  directoryPrefix = 'sflow-distribution-',
  keyDirectoryPrefix = 'sflow-distribution-key-'
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), directoryPrefix));
  const keyDirectory = await mkdtemp(path.join(os.tmpdir(), keyDirectoryPrefix));
  const tarballName = `singularity-flow-${version}.tgz`;
  const vsixName = `singularity-flow-vscode-${version}.vsix`;
  const tarballBytes = npmTarball({ name: 'singularity-flow', version });
  const vsixBytes = storedZip('extension/package.json', Buffer.from(JSON.stringify({
    publisher: 'singularityflow', name: 'singularity-flow-vscode', version: vsixVersion
  })));
  await writeFile(path.join(directory, tarballName), tarballBytes);
  await writeFile(path.join(directory, vsixName), vsixBytes);
  for (const name of [...DISTRIBUTION_OPERATOR_SCRIPTS, ...DISTRIBUTION_OPERATOR_DOCUMENTATION]) {
    await copyFile(path.join(root, 'distribution', name), path.join(directory, name));
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(keyDirectory, 'artifact-builder-public.pem');
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const receipt = signReleaseArtifactReceipt({
    schemaVersion: 1,
    kind: 'singularity-flow-release-artifact-receipt',
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    generatedAt: '2026-01-01T00:00:00.000Z',
    builderIdentity: 'fixture-builder',
    packageEntryManifestSha256: `sha256:${'c'.repeat(64)}`,
    packagingProfile: {
      nodeVersion: '22.9.0', npmVersion: '10.8.3', zlibVersion: '1.3.1',
      sourceDateEpoch: '1',
      npmToolchainLockSha256: `sha256:${'d'.repeat(64)}`,
      productionDependencyLockSha256: `sha256:${'e'.repeat(64)}`,
      vsceToolchainLockSha256: `sha256:${'f'.repeat(64)}`
    },
    artifacts: [
      {
        kind: 'cli-and-copilot-plugin', name: tarballName,
        sha256: `sha256:${fileSha256(tarballBytes)}`, sizeBytes: tarballBytes.length
      },
      {
        kind: 'vscode-extension', name: vsixName,
        sha256: `sha256:${fileSha256(vsixBytes)}`, sizeBytes: vsixBytes.length
      }
    ]
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'fixture-builder');
  await writeFile(path.join(directory, 'ARTIFACT-RECEIPT.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const entries = [
    tarballName, vsixName, ...DISTRIBUTION_OPERATOR_SCRIPTS,
    ...DISTRIBUTION_OPERATOR_DOCUMENTATION
  ];
  const sums = [];
  for (const name of entries) {
    const bytes = name === tarballName ? tarballBytes
      : name === vsixName ? vsixBytes
        : await readFile(path.join(directory, name));
    sums.push(`${fileSha256(bytes)}  ${name}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  await writeFile(path.join(directory, 'RELEASE.json'), `${JSON.stringify({
    version,
    commit: 'a'.repeat(40),
    artifactReceiptSha256: receipt.signature.payloadSha256,
    artefacts: [tarballName, vsixName],
    operatorScripts: DISTRIBUTION_OPERATOR_SCRIPTS,
    operatorDocumentation: DISTRIBUTION_OPERATOR_DOCUMENTATION
  }, null, 2)}\n`);
  return { directory, keyDirectory, publicKeyPath, version, tarballName, vsixName };
}
