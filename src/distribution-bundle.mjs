import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectNpmTarball, inspectVsix } from '../scripts/install-staged-artifacts.mjs';
import {
  createVerifiedReleaseArtifactSnapshot, verifyReleaseArtifactReceipt
} from './release-artifact-receipt.mjs';
import { readStableReleaseFile, readStableReleaseJson } from './secure-release-files.mjs';
import { SingularityFlowError } from './util.mjs';

const SHA256_LINE = /^([a-f0-9]{64})  ([^\0\r\n]+)$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
export const DISTRIBUTION_OPERATOR_SCRIPTS = Object.freeze([
  'bootstrap.mjs',
  'install.cmd', 'install.ps1', 'install.sh',
  'uninstall.cmd', 'uninstall.ps1', 'uninstall.sh'
]);
export const DISTRIBUTION_OPERATOR_DOCUMENTATION = Object.freeze(['README.md']);
const canonicalAssetDirectory = path.resolve(fileURLToPath(new URL('../distribution/', import.meta.url)));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new SingularityFlowError(`Distribution bundle refused: ${message}`);
}

function names(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail(`${label} must be a non-empty bounded array.`);
  }
  const result = value.map((entry) => {
    if (typeof entry !== 'string' || !SAFE_NAME.test(entry) || path.basename(entry) !== entry) {
      fail(`${label} contains an unsafe filename.`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) fail(`${label} contains a duplicate filename.`);
  return result;
}

function checksumMap(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('SHA256SUMS is not valid UTF-8.'); }
  const records = new Map();
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(SHA256_LINE);
    if (!match || !SAFE_NAME.test(match[2]) || path.basename(match[2]) !== match[2]) {
      fail('SHA256SUMS contains an invalid record.');
    }
    if (records.has(match[2])) fail(`SHA256SUMS contains duplicate entry '${match[2]}'.`);
    records.set(match[2], match[1]);
  }
  if (!records.size) fail('SHA256SUMS is empty.');
  return records;
}

async function verifiedFile(directory, name, expected, label) {
  const file = path.join(directory, name);
  const stable = await readStableReleaseFile(file, { label, maxBytes: 512 * 1024 * 1024 });
  const observed = sha256(stable.bytes);
  if (observed !== expected) fail(`${label} digest does not match SHA256SUMS.`);
  return Object.freeze({ path: file, sha256: `sha256:${observed}` });
}

/**
 * Admit one promoted release directory without trusting filenames alone.
 *
 * The signed npm tarball remains the executable trust boundary. RELEASE.json selects the exact
 * pair, SHA256SUMS binds every distributed operator script, and the archive inspectors prove the
 * package/extension identities and version before any installed surface is changed.
 */
export async function inspectDistributionBundle(requestedDirectory, {
  trustedPublicKeyPem,
  snapshot = false,
  tempRoot
} = {}) {
  if (!trustedPublicKeyPem) fail('an explicitly trusted artifact-builder public key is required.');
  const requested = path.resolve(String(requestedDirectory || '.'));
  const info = await lstat(requested).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    fail(`release directory is not an ordinary directory: ${requested}`);
  }
  const directory = await realpath(requested);
  const [releaseFile, sumsFile, receiptFile] = await Promise.all([
    readStableReleaseJson(path.join(directory, 'RELEASE.json'), {
      label: 'Distribution RELEASE.json', maxBytes: 1024 * 1024
    }),
    readStableReleaseFile(path.join(directory, 'SHA256SUMS'), {
      label: 'Distribution SHA256SUMS', maxBytes: 1024 * 1024
    }),
    readStableReleaseJson(path.join(directory, 'ARTIFACT-RECEIPT.json'), {
      label: 'Distribution ARTIFACT-RECEIPT.json', maxBytes: 16 * 1024 * 1024
    })
  ]).catch((error) => fail(error.message));
  const release = releaseFile.value;
  if (!release || typeof release !== 'object' || Array.isArray(release)) fail('RELEASE.json is not an object.');
  if (typeof release.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u.test(release.version)) {
    fail('RELEASE.json has no valid version.');
  }
  const productArtifacts = names(release.artefacts, 'RELEASE.json artefacts');
  if (productArtifacts.length !== 2) fail('RELEASE.json must bind exactly the npm tarball and VSIX.');
  const tarballName = productArtifacts.find((entry) => entry.endsWith('.tgz'));
  const vsixName = productArtifacts.find((entry) => entry.endsWith('.vsix'));
  if (!tarballName || !vsixName) fail('RELEASE.json must name one .tgz and one .vsix product artifact.');
  const operatorScripts = names(release.operatorScripts, 'RELEASE.json operatorScripts');
  if (JSON.stringify([...operatorScripts].sort()) !== JSON.stringify([...DISTRIBUTION_OPERATOR_SCRIPTS].sort())) {
    fail(`RELEASE.json must name the exact operator script set: ${DISTRIBUTION_OPERATOR_SCRIPTS.join(', ')}.`);
  }
  const operatorDocumentation = names(
    release.operatorDocumentation, 'RELEASE.json operatorDocumentation'
  );
  if (JSON.stringify([...operatorDocumentation].sort())
      !== JSON.stringify([...DISTRIBUTION_OPERATOR_DOCUMENTATION].sort())) {
    fail(`RELEASE.json must name the exact operator documentation set: ${DISTRIBUTION_OPERATOR_DOCUMENTATION.join(', ')}.`);
  }
  if (release.artifactReceiptSha256 !== receiptFile.value?.signature?.payloadSha256) {
    fail('RELEASE.json does not bind the signed artifact receipt payload.');
  }
  const checksums = checksumMap(sumsFile.bytes);
  const required = [...productArtifacts, ...operatorScripts, ...operatorDocumentation];
  for (const name of required) {
    if (!checksums.has(name)) fail(`SHA256SUMS does not bind '${name}'.`);
  }
  const verified = new Map();
  for (const name of required) {
    verified.set(name, await verifiedFile(directory, name, checksums.get(name), `Distribution file ${name}`));
  }
  // The npm tarball is the signed executable boundary. These canonical copies are inside that
  // package, so a replaced wrapper plus recomputed unsigned SHA256SUMS cannot authorize itself.
  for (const name of [...operatorScripts, ...operatorDocumentation]) {
    const canonical = await readStableReleaseFile(path.join(canonicalAssetDirectory, name), {
      label: `Packaged operator script ${name}`, maxBytes: 1024 * 1024
    }).catch((error) => fail(error.message));
    if (`sha256:${sha256(canonical.bytes)}` !== verified.get(name).sha256) {
      fail(`operator script '${name}' does not match the copy embedded in the signed npm package.`);
    }
  }
  let signed;
  try {
    signed = snapshot
      ? await createVerifiedReleaseArtifactSnapshot(receiptFile.value, {
        trustedPublicKeyPem,
        expectedCommit: release.commit,
        packagePath: verified.get(tarballName).path,
        vsixPath: verified.get(vsixName).path,
        tempRoot
      })
      : await verifyReleaseArtifactReceipt(receiptFile.value, {
        trustedPublicKeyPem,
        expectedCommit: release.commit,
        packagePath: verified.get(tarballName).path,
        vsixPath: verified.get(vsixName).path
      });
  } catch (error) { fail(error.message); }
  const artifactPaths = snapshot
    ? { tarball: signed.packagePath, vsix: signed.vsixPath }
    : { tarball: verified.get(tarballName).path, vsix: verified.get(vsixName).path };
  const [tarball, vsix] = await Promise.all([
    inspectNpmTarball(artifactPaths.tarball),
    inspectVsix(artifactPaths.vsix)
  ]).catch((error) => fail(error.message));
  if (tarball.sha256 !== verified.get(tarballName).sha256
      || vsix.sha256 !== verified.get(vsixName).sha256) {
    fail('a product artifact changed after checksum verification.');
  }
  if (tarball.version !== release.version || vsix.version !== release.version) {
    fail(`artifact version mismatch: release ${release.version}, npm ${tarball.version}, VSIX ${vsix.version}.`);
  }
  return Object.freeze({
    directory,
    version: release.version,
    release,
    artifactAuthority: Object.freeze({
      payloadSha256: signed.payloadSha256,
      signerKeySha256: signed.signerKeySha256,
      builderIdentity: signed.builderIdentity
    }),
    releaseSha256: `sha256:${sha256(releaseFile.bytes)}`,
    sumsSha256: `sha256:${sha256(sumsFile.bytes)}`,
    receiptSha256: `sha256:${sha256(receiptFile.bytes)}`,
    snapshotDirectory: snapshot ? signed.snapshotDirectory : null,
    tarball,
    vsix,
    operatorScripts: Object.freeze(operatorScripts.map((name) => Object.freeze({
      name, ...verified.get(name)
    }))),
    operatorDocumentation: Object.freeze(operatorDocumentation.map((name) => Object.freeze({
      name, ...verified.get(name)
    })))
  });
}
