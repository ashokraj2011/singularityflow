/** Signed provenance for the one immutable npm/VSIX pair consumed by every release cell. */
import {
  createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes
} from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const RELEASE_ARTIFACT_RECEIPT_VERSION = 1;
export const RELEASE_ARTIFACT_KINDS = Object.freeze([
  'cli-and-copilot-plugin', 'vscode-extension'
]);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function publicKeyDer(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  return publicKey.export({ type: 'spki', format: 'der' });
}

function payload(receipt) {
  const copy = structuredClone(receipt);
  delete copy.signature;
  return canonicalJson(copy);
}

function exactKeys(value, keys) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function validTimestamp(value) {
  const milliseconds = typeof value === 'string' && value.endsWith('Z') ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateUnsigned(receipt) {
  const failures = [];
  const expectedKeys = [
    'artifacts', 'builderIdentity', 'generatedAt', 'kind', 'packageEntryManifestSha256',
    'packagingProfile', 'schemaVersion', 'sourceCommit', 'sourceTree'
  ];
  if (!exactKeys(receipt, expectedKeys)) failures.push('artifact receipt fields are invalid');
  if (receipt?.schemaVersion !== RELEASE_ARTIFACT_RECEIPT_VERSION) { // schema-transient: externally signed transport receipt
    failures.push(`schemaVersion must be ${RELEASE_ARTIFACT_RECEIPT_VERSION}`);
  }
  if (receipt?.kind !== 'singularity-flow-release-artifact-receipt') failures.push('kind is invalid');
  if (!GIT_OBJECT_ID.test(String(receipt?.sourceCommit ?? ''))) failures.push('sourceCommit is invalid');
  if (!GIT_OBJECT_ID.test(String(receipt?.sourceTree ?? ''))) failures.push('sourceTree is invalid');
  if (!validTimestamp(receipt?.generatedAt)) failures.push('generatedAt is invalid');
  if (typeof receipt?.builderIdentity !== 'string' || receipt.builderIdentity.trim() !== receipt.builderIdentity
      || !receipt.builderIdentity || receipt.builderIdentity.length > 256
      || /[\u0000-\u001f\u007f]/.test(receipt.builderIdentity)) {
    failures.push('builderIdentity is invalid');
  }
  if (!SHA256.test(String(receipt?.packageEntryManifestSha256 ?? ''))) {
    failures.push('packageEntryManifestSha256 is invalid');
  }
  const profileKeys = [
    'nodeVersion', 'npmToolchainLockSha256', 'npmVersion', 'sourceDateEpoch',
    'productionDependencyLockSha256', 'vsceToolchainLockSha256', 'zlibVersion'
  ];
  if (!exactKeys(receipt?.packagingProfile, profileKeys)) failures.push('packagingProfile fields are invalid');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(receipt?.packagingProfile?.nodeVersion ?? ''))) {
    failures.push('packagingProfile nodeVersion is invalid');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(receipt?.packagingProfile?.npmVersion ?? ''))) {
    failures.push('packagingProfile npmVersion is invalid');
  }
  if (typeof receipt?.packagingProfile?.zlibVersion !== 'string' || !receipt.packagingProfile.zlibVersion) {
    failures.push('packagingProfile zlibVersion is invalid');
  }
  if (!/^(?:0|[1-9]\d*)$/.test(String(receipt?.packagingProfile?.sourceDateEpoch ?? ''))) {
    failures.push('packagingProfile sourceDateEpoch is invalid');
  }
  for (const field of [
    'npmToolchainLockSha256', 'productionDependencyLockSha256', 'vsceToolchainLockSha256'
  ]) {
    if (!SHA256.test(String(receipt?.packagingProfile?.[field] ?? ''))) {
      failures.push(`packagingProfile ${field} is invalid`);
    }
  }
  if (!Array.isArray(receipt?.artifacts) || receipt.artifacts.length !== RELEASE_ARTIFACT_KINDS.length) {
    failures.push('artifacts must contain exactly the npm package and VSIX');
  } else {
    const seen = new Set();
    for (const artifact of receipt.artifacts) {
      if (!exactKeys(artifact, ['kind', 'name', 'sha256', 'sizeBytes'])) {
        failures.push('artifact fields are invalid');
        continue;
      }
      if (!RELEASE_ARTIFACT_KINDS.includes(artifact.kind) || seen.has(artifact.kind)) {
        failures.push('artifact kind is invalid or repeated');
      }
      seen.add(artifact.kind);
      if (!SAFE_NAME.test(String(artifact.name ?? '')) || String(artifact.name ?? '').length > 255) {
        failures.push('artifact name is unsafe');
      }
      if (artifact.kind === 'cli-and-copilot-plugin' && !String(artifact.name ?? '').endsWith('.tgz')) {
        failures.push('CLI artifact name must end in .tgz');
      }
      if (artifact.kind === 'vscode-extension' && !String(artifact.name ?? '').endsWith('.vsix')) {
        failures.push('VS Code artifact name must end in .vsix');
      }
      if (!SHA256.test(String(artifact.sha256 ?? ''))) failures.push('artifact digest is invalid');
      if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 1
          || artifact.sizeBytes > MAX_ARTIFACT_BYTES) failures.push('artifact size is invalid');
    }
    for (const kind of RELEASE_ARTIFACT_KINDS) {
      if (!seen.has(kind)) failures.push(`artifact ${kind} is absent`);
    }
  }
  return failures;
}

/** Sign one already-built immutable artifact pair. */
export function signReleaseArtifactReceipt(unsignedReceipt, privateKeyPem, builderIdentity) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new SingularityFlowError('Release artifact receipts require an Ed25519 signing key.', {
      code: 'RELEASE_ARTIFACT_SIGNING_KEY_INVALID'
    });
  }
  const publicDer = publicKeyDer(privateKey);
  const receipt = {
    ...structuredClone(unsignedReceipt),
    builderIdentity: String(builderIdentity ?? '').trim()
  };
  const failures = validateUnsigned(receipt);
  if (failures.length) {
    throw new SingularityFlowError(`Release artifact receipt is invalid: ${failures.join('; ')}.`, {
      code: 'RELEASE_ARTIFACT_RECEIPT_INVALID', details: { failures }
    });
  }
  const canonical = payload(receipt);
  return {
    ...receipt,
    signature: {
      algorithm: 'ed25519',
      publicKeySpki: publicDer.toString('base64'),
      publicKeySha256: sha256(publicDer),
      payloadSha256: sha256(canonical),
      value: signBytes(null, Buffer.from(canonical), privateKey).toString('base64')
    }
  };
}

async function verifyArtifactFile(file, expected, { copyTo = null } = {}) {
  const resolved = path.resolve(file);
  let before;
  try {
    before = await lstat(resolved);
  } catch {
    throw new SingularityFlowError(`Release artifact is missing: ${resolved}.`, {
      code: 'RELEASE_ARTIFACT_MISSING'
    });
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ARTIFACT_BYTES) {
    throw new SingularityFlowError(`Release artifact must be an ordinary file: ${resolved}.`, {
      code: 'RELEASE_ARTIFACT_UNSAFE'
    });
  }
  let handle;
  let destination = null;
  try {
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new SingularityFlowError(`Release artifact could not be opened without following a link: ${resolved}.`, {
      code: 'RELEASE_ARTIFACT_UNSAFE'
    });
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_ARTIFACT_BYTES
        || opened.size !== before.size || opened.size !== expected.sizeBytes) {
      throw new SingularityFlowError(`Release artifact changed size before it could be read: ${expected.name}.`, {
        code: 'RELEASE_ARTIFACT_MISMATCH'
      });
    }
    if (copyTo) destination = await open(copyTo, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, opened.size));
    let total = 0;
    while (total < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - total), total);
      if (bytesRead < 1) {
        throw new SingularityFlowError(`Release artifact ended while it was read: ${expected.name}.`, {
          code: 'RELEASE_ARTIFACT_MISMATCH'
        });
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (destination) {
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(chunk, written, bytesRead - written, total + written);
          if (result.bytesWritten < 1) throw new Error(`Could not snapshot release artifact ${expected.name}.`);
          written += result.bytesWritten;
        }
      }
      total += bytesRead;
    }
    if (destination) await destination.sync();
    const after = await lstat(resolved).catch(() => null);
    const sameIdentity = after?.isFile() && !after.isSymbolicLink()
      && before.size === opened.size && opened.size === after.size && total === opened.size
      && (!before.ino || !opened.ino || (before.ino === opened.ino && before.dev === opened.dev))
      && (!after.ino || !opened.ino || (after.ino === opened.ino && after.dev === opened.dev));
    if (!sameIdentity || path.basename(resolved) !== expected.name
        || `sha256:${hash.digest('hex')}` !== expected.sha256) {
      throw new SingularityFlowError(`Release artifact bytes do not match the signed receipt: ${expected.name}.`, {
        code: 'RELEASE_ARTIFACT_MISMATCH'
      });
    }
  } finally {
    if (destination) await destination.close();
    await handle.close();
  }
  return resolved;
}

/** Verify the artifact-builder trust root, signature, and immutable source/artifact subject. */
export function verifyReleaseArtifactReceiptAuthority(receipt, {
  trustedPublicKeyPem,
  expectedCommit = null,
  expectedTree = null
} = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new SingularityFlowError('Release artifact receipt must be an object.', {
      code: 'RELEASE_ARTIFACT_RECEIPT_INVALID'
    });
  }
  const signature = receipt.signature;
  if (signature?.algorithm !== 'ed25519' || !trustedPublicKeyPem) {
    throw new SingularityFlowError(
      'Release artifact receipt requires an Ed25519 signature and an explicitly trusted builder key.',
      { code: 'RELEASE_ARTIFACT_RECEIPT_UNTRUSTED' }
    );
  }
  let trusted;
  try {
    trusted = createPublicKey(trustedPublicKeyPem);
  } catch {
    throw new SingularityFlowError('Release artifact builder key is invalid.', {
      code: 'RELEASE_ARTIFACT_RECEIPT_UNTRUSTED'
    });
  }
  if (trusted.asymmetricKeyType !== 'ed25519') {
    throw new SingularityFlowError('Release artifact builder key must be Ed25519.', {
      code: 'RELEASE_ARTIFACT_RECEIPT_UNTRUSTED'
    });
  }
  if (!exactKeys(signature, [
    'algorithm', 'payloadSha256', 'publicKeySha256', 'publicKeySpki', 'value'
  ])) {
    throw new SingularityFlowError('Release artifact receipt signature fields are invalid.', {
      code: 'RELEASE_ARTIFACT_RECEIPT_SIGNATURE_INVALID'
    });
  }
  const trustedDer = publicKeyDer(trusted);
  const embedded = Buffer.from(String(signature.publicKeySpki ?? ''), 'base64');
  if (!embedded.equals(trustedDer) || signature.publicKeySha256 !== sha256(trustedDer)) {
    throw new SingularityFlowError('Release artifact receipt signer is not the trusted builder key.', {
      code: 'RELEASE_ARTIFACT_RECEIPT_UNTRUSTED'
    });
  }
  const canonical = payload(receipt);
  if (signature.payloadSha256 !== sha256(canonical)
      || !verifyBytes(null, Buffer.from(canonical), trusted, Buffer.from(String(signature.value ?? ''), 'base64'))) {
    throw new SingularityFlowError('Release artifact receipt signature or payload digest is invalid.', {
      code: 'RELEASE_ARTIFACT_RECEIPT_SIGNATURE_INVALID'
    });
  }
  const failures = validateUnsigned((({ signature: _signature, ...unsigned }) => unsigned)(receipt));
  if (expectedCommit && receipt.sourceCommit !== expectedCommit) failures.push('sourceCommit does not match release HEAD');
  if (expectedTree && receipt.sourceTree !== expectedTree) failures.push('sourceTree does not match release HEAD');
  if (failures.length) {
    throw new SingularityFlowError(`Release artifact receipt is invalid: ${failures.join('; ')}.`, {
      code: 'RELEASE_ARTIFACT_RECEIPT_INVALID', details: { failures }
    });
  }
  const byKind = Object.fromEntries(receipt.artifacts.map((artifact) => [artifact.kind, artifact]));
  return Object.freeze({
    valid: true,
    payloadSha256: signature.payloadSha256,
    signerKeySha256: signature.publicKeySha256,
    builderIdentity: receipt.builderIdentity,
    sourceCommit: receipt.sourceCommit,
    sourceTree: receipt.sourceTree,
    packageSha256: byKind['cli-and-copilot-plugin'].sha256,
    vsixSha256: byKind['vscode-extension'].sha256,
    artifacts: structuredClone(byKind)
  });
}

/** Verify the signed authority and optionally the exact artifact files it names. */
export async function verifyReleaseArtifactReceipt(receipt, {
  trustedPublicKeyPem,
  expectedCommit = null,
  expectedTree = null,
  packagePath = null,
  vsixPath = null
} = {}) {
  const authority = verifyReleaseArtifactReceiptAuthority(receipt, {
    trustedPublicKeyPem, expectedCommit, expectedTree
  });
  if ((packagePath == null) !== (vsixPath == null)) {
    throw new SingularityFlowError('Release artifact file verification requires both the npm package and VSIX.', {
      code: 'RELEASE_ARTIFACT_PAIR_REQUIRED'
    });
  }
  const files = {};
  if (packagePath != null) files.packagePath = await verifyArtifactFile(
    packagePath, authority.artifacts['cli-and-copilot-plugin']
  );
  if (vsixPath != null) files.vsixPath = await verifyArtifactFile(
    vsixPath, authority.artifacts['vscode-extension']
  );
  return Object.freeze({
    ...authority,
    ...files
  });
}

/**
 * Copy descriptor-verified artifact bytes into a new private directory.
 *
 * Consumers must execute and promote only these paths. The handoff directory may be writable by a
 * different process; retaining an open descriptor while hashing and copying prevents a path swap
 * between receipt verification and artifact execution.
 */
export async function createVerifiedReleaseArtifactSnapshot(receipt, {
  trustedPublicKeyPem,
  expectedCommit = null,
  expectedTree = null,
  packagePath,
  vsixPath,
  tempRoot = os.tmpdir()
} = {}) {
  const authority = verifyReleaseArtifactReceiptAuthority(receipt, {
    trustedPublicKeyPem, expectedCommit, expectedTree
  });
  if (!packagePath || !vsixPath) {
    throw new SingularityFlowError('A private artifact snapshot requires both the npm package and VSIX.', {
      code: 'RELEASE_ARTIFACT_PAIR_REQUIRED'
    });
  }
  await mkdir(path.resolve(tempRoot), { recursive: true });
  const directory = await mkdtemp(path.join(path.resolve(tempRoot), 'sflow-release-artifact-snapshot-'));
  await chmod(directory, 0o700);
  try {
    const snapshotPackage = path.join(directory, authority.artifacts['cli-and-copilot-plugin'].name);
    const snapshotVsix = path.join(directory, authority.artifacts['vscode-extension'].name);
    // Copy sequentially with a fixed-size buffer: a large but valid pair cannot allocate both
    // artifacts in memory, and the destination is never reopened by an untrusted path.
    await verifyArtifactFile(packagePath, authority.artifacts['cli-and-copilot-plugin'], {
      copyTo: snapshotPackage
    });
    await verifyArtifactFile(vsixPath, authority.artifacts['vscode-extension'], {
      copyTo: snapshotVsix
    });
    const snapshot = await verifyReleaseArtifactReceipt(receipt, {
      trustedPublicKeyPem,
      expectedCommit,
      expectedTree,
      packagePath: snapshotPackage,
      vsixPath: snapshotVsix
    });
    return Object.freeze({ ...snapshot, snapshotDirectory: directory });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
