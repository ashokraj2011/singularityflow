/** Independently verifiable clean-checkout release evidence for installations without hosted CI. */
import {
  createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes
} from 'node:crypto';

import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

const SUPPORTED_RELEASE_PLATFORMS = Object.freeze(['darwin', 'linux', 'win32']);
const SUPPORTED_RELEASE_NODE_MAJORS = Object.freeze([20, 22]);

/**
 * The reviewed release matrix: minimum Node plus the repository's current pinned Node line on all
 * three supported hosts. Developer checks do not require this aggregate; real release promotion
 * does, through scripts/release.mjs.
 */
export const REQUIRED_RELEASE_PLATFORM_MATRIX = Object.freeze(
  SUPPORTED_RELEASE_PLATFORMS.flatMap((platform) => (
    SUPPORTED_RELEASE_NODE_MAJORS.map((nodeMajor) => Object.freeze({ platform, nodeMajor }))
  ))
);

function publicKeyDer(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  return publicKey.export({ type: 'spki', format: 'der' });
}

function payload(receipt) {
  const copy = structuredClone(receipt);
  delete copy.signature;
  return canonicalJson(copy);
}

function nodeMajor(value) {
  const match = String(value ?? '').match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

function matrixKey(value) { return `${value.platform}/node-${value.nodeMajor}`; }

function validatePlatformMatrix(receipt, required = null) {
  if (receipt.platformMatrix == null) {
    if (required?.length) return { failures: ['platformMatrix is absent'], cells: [] };
    return { failures: [], cells: [] };
  }
  if (!Array.isArray(receipt.platformMatrix) || !receipt.platformMatrix.length) {
    return { failures: ['platformMatrix is empty'], cells: [] };
  }
  const failures = [];
  const cells = [];
  const seen = new Set();
  const artifact = receipt.artifactEvidence;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
      || JSON.stringify(Object.keys(artifact).sort()) !== JSON.stringify([
        'payloadSha256', 'signerKeySha256', 'verifierIdentity'
      ])
      || !/^sha256:[a-f0-9]{64}$/.test(String(artifact.payloadSha256 ?? ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(artifact.signerKeySha256 ?? ''))
      || typeof artifact.verifierIdentity !== 'string' || !artifact.verifierIdentity.trim()) {
    failures.push('artifactEvidence is invalid');
  }
  for (const entry of receipt.platformMatrix) {
    const major = nodeMajor(entry?.nodeVersion);
    const exactFields = entry && typeof entry === 'object' && !Array.isArray(entry)
      && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify([
        'evidencePayloadSha256', 'evidenceSignerKeySha256', 'evidenceVerifierIdentity',
        'nodeMajor', 'nodeVersion', 'platform'
      ]);
    const valid = entry && typeof entry === 'object' && !Array.isArray(entry)
      && exactFields
      && SUPPORTED_RELEASE_PLATFORMS.includes(entry.platform)
      && Number.isInteger(entry.nodeMajor) && entry.nodeMajor === major
      && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(entry.nodeVersion ?? ''))
      && /^sha256:[a-f0-9]{64}$/.test(String(entry.evidencePayloadSha256 ?? ''))
      && /^sha256:[a-f0-9]{64}$/.test(String(entry.evidenceSignerKeySha256 ?? ''))
      && typeof entry.evidenceVerifierIdentity === 'string'
      && entry.evidenceVerifierIdentity.trim().length > 0;
    if (!valid) {
      failures.push('platformMatrix contains an invalid evidence cell');
      continue;
    }
    const cell = {
      platform: entry.platform,
      nodeVersion: entry.nodeVersion,
      nodeMajor: entry.nodeMajor,
      evidencePayloadSha256: entry.evidencePayloadSha256,
      evidenceSignerKeySha256: entry.evidenceSignerKeySha256,
      evidenceVerifierIdentity: entry.evidenceVerifierIdentity.trim()
    };
    const key = matrixKey(cell);
    if (seen.has(key)) failures.push(`platformMatrix repeats ${key}`);
    seen.add(key);
    cells.push(cell);
  }
  const platforms = [...new Set(cells.map((cell) => cell.platform))].sort();
  const versions = [...new Set(cells.map((cell) => cell.nodeVersion))].sort();
  if (JSON.stringify(platforms) !== JSON.stringify([...(receipt.platforms ?? [])].sort())) {
    failures.push('platforms do not equal the platformMatrix projection');
  }
  if (JSON.stringify(versions) !== JSON.stringify([...(receipt.nodeVersions ?? [])].sort())) {
    failures.push('nodeVersions do not equal the platformMatrix projection');
  }
  const missing = (required ?? []).map(matrixKey).filter((key) => !seen.has(key));
  if (missing.length) failures.push(`required platform matrix is incomplete: ${missing.join(', ')}`);
  return { failures, cells };
}

export function signVerificationReceipt(unsignedReceipt, privateKeyPem, verifierIdentity) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new SingularityFlowError('Verification receipts require an Ed25519 signing key.', {
      code: 'VERIFICATION_SIGNING_KEY_INVALID'
    });
  }
  const publicDer = publicKeyDer(privateKey);
  const receipt = {
    ...structuredClone(unsignedReceipt),
    verifierIdentity: String(verifierIdentity ?? '').trim()
  };
  if (!receipt.verifierIdentity) {
    throw new SingularityFlowError('Verification receipt requires a verifier identity.', {
      code: 'VERIFICATION_RECEIPT_INVALID'
    });
  }
  const canonical = payload(receipt);
  return {
    ...receipt,
    signature: {
      algorithm: 'ed25519',
      publicKeySpki: publicDer.toString('base64'),
      publicKeySha256: `sha256:${sha256(publicDer)}`,
      payloadSha256: `sha256:${sha256(canonical)}`,
      value: signBytes(null, Buffer.from(canonical), privateKey).toString('base64')
    }
  };
}

export function verifyVerificationReceipt(receipt, {
  trustedPublicKeyPem,
  expectedCommit = null,
  expectedTree = null,
  expectedPackageSha256 = null,
  expectedVsixSha256 = null,
  requiredPlatformMatrix = null
} = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new SingularityFlowError('Verification receipt must be an object.', { code: 'VERIFICATION_RECEIPT_INVALID' });
  }
  const signature = receipt.signature;
  if (signature?.algorithm !== 'ed25519' || !trustedPublicKeyPem) {
    throw new SingularityFlowError('Verification receipt requires an Ed25519 signature and an explicitly trusted public key.', {
      code: 'VERIFICATION_RECEIPT_UNTRUSTED'
    });
  }
  const trusted = createPublicKey(trustedPublicKeyPem);
  const trustedDer = publicKeyDer(trusted);
  const embedded = Buffer.from(String(signature.publicKeySpki ?? ''), 'base64');
  if (!embedded.equals(trustedDer)
      || signature.publicKeySha256 !== `sha256:${sha256(trustedDer)}`) {
    throw new SingularityFlowError('Verification receipt signing key is not the trusted release verifier key.', {
      code: 'VERIFICATION_RECEIPT_UNTRUSTED'
    });
  }
  const canonical = payload(receipt);
  if (signature.payloadSha256 !== `sha256:${sha256(canonical)}`
      || !verifyBytes(null, Buffer.from(canonical), trusted, Buffer.from(String(signature.value ?? ''), 'base64'))) {
    throw new SingularityFlowError('Verification receipt signature or payload digest is invalid.', {
      code: 'VERIFICATION_RECEIPT_SIGNATURE_INVALID'
    });
  }
  const failures = [];
  if (receipt.cleanCheckout !== true) failures.push('cleanCheckout is not true');
  if (receipt.npmCi !== 'passed') failures.push('npmCi did not pass');
  if (receipt.npmRunCheck?.passed !== true
      || !Number.isInteger(receipt.npmRunCheck?.checks) || receipt.npmRunCheck.checks < 1) {
    failures.push('npmRunCheck did not record a positive passing check count');
  }
  if (receipt.npmTest?.failed !== 0
      || !Number.isInteger(receipt.npmTest?.passed) || receipt.npmTest.passed < 1) {
    failures.push('npmTest has no passing zero-failure result');
  }
  if (receipt.vscodeBuild !== 'passed') failures.push('vscodeBuild did not pass');
  if (!Array.isArray(receipt.platforms) || !receipt.platforms.length) failures.push('platforms are absent');
  if (!Array.isArray(receipt.nodeVersions) || !receipt.nodeVersions.length) failures.push('nodeVersions are absent');
  failures.push(...validatePlatformMatrix(receipt, requiredPlatformMatrix).failures);
  if (!/^sha256:[a-f0-9]{64}$/.test(String(receipt.packageSha256 ?? ''))) failures.push('packageSha256 is invalid');
  if (!/^sha256:[a-f0-9]{64}$/.test(String(receipt.vsixSha256 ?? ''))) failures.push('vsixSha256 is invalid');
  if (expectedCommit && receipt.commit !== expectedCommit) failures.push('commit does not match release HEAD');
  if (expectedTree && receipt.tree !== expectedTree) failures.push('tree does not match release HEAD');
  if (expectedPackageSha256 && receipt.packageSha256 !== expectedPackageSha256) failures.push('package digest does not match release artifact');
  if (expectedVsixSha256 && receipt.vsixSha256 !== expectedVsixSha256) failures.push('VSIX digest does not match release artifact');
  if (failures.length) {
    throw new SingularityFlowError(`Verification receipt cannot authorize release: ${failures.join('; ')}.`, {
      code: 'VERIFICATION_RECEIPT_REJECTED', details: { failures }
    });
  }
  return {
    valid: true,
    verifierIdentity: receipt.verifierIdentity,
    publicKeySha256: signature.publicKeySha256,
    commit: receipt.commit,
    tree: receipt.tree,
    packageSha256: receipt.packageSha256,
    vsixSha256: receipt.vsixSha256
  };
}

function embeddedPublicKey(receipt) {
  try {
    return createPublicKey({
      key: Buffer.from(String(receipt?.signature?.publicKeySpki ?? ''), 'base64'),
      format: 'der',
      type: 'spki'
    }).export({ type: 'spki', format: 'pem' });
  } catch (error) {
    throw new SingularityFlowError(`Matrix evidence has an invalid embedded public key: ${error.message}`, {
      code: 'VERIFICATION_RECEIPT_UNTRUSTED'
    });
  }
}

/**
 * Review and merge independently signed, single-host receipts for one exact release commit.
 * The aggregate is signed again by the release verifier; promotion trusts that outer reviewer and
 * can still identify the exact signed payload and signer behind every matrix cell.
 */
export function mergeSignedVerificationReceipts(receipts, privateKeyPem, verifierIdentity, {
  generatedAt = new Date().toISOString(),
  artifactReceipt = null
} = {}) {
  if (!Array.isArray(receipts) || !receipts.length) {
    throw new SingularityFlowError('Verification receipt merge requires at least one signed receipt.', {
      code: 'VERIFICATION_RECEIPT_INVALID'
    });
  }
  const verified = receipts.map((receipt) => {
    verifyVerificationReceipt(receipt, { trustedPublicKeyPem: embeddedPublicKey(receipt) });
    if (receipt.platformMatrix != null
        || receipt.platforms.length !== 1 || receipt.nodeVersions.length !== 1) {
      throw new SingularityFlowError(
        'Matrix evidence must be one original single-platform, single-Node signed receipt.',
        { code: 'VERIFICATION_RECEIPT_INVALID' }
      );
    }
    return receipt;
  });
  const first = verified[0];
  for (const receipt of verified.slice(1)) {
    // Release promotion claims one reproducible artifact set, not merely six test runs over the
    // same source. A platform-specific tarball/VSIX would make the aggregate's selected artifact
    // evidence conceal disagreement in another matrix cell.
    for (const field of ['commit', 'tree', 'packageSha256', 'vsixSha256']) {
      if (receipt[field] !== first[field]) {
        throw new SingularityFlowError(
          `Verification receipt matrix evidence disagrees on ${field}.`,
          { code: 'VERIFICATION_RECEIPT_REJECTED', details: { field } }
        );
      }
    }
  }
  const artifactEvidence = artifactReceipt ?? first;
  verifyVerificationReceipt(artifactEvidence, {
    trustedPublicKeyPem: embeddedPublicKey(artifactEvidence),
    expectedCommit: first.commit,
    expectedTree: first.tree
  });
  const byCell = new Map();
  for (const receipt of verified) {
    const cell = {
      platform: receipt.platforms[0],
      nodeVersion: receipt.nodeVersions[0],
      nodeMajor: nodeMajor(receipt.nodeVersions[0]),
      evidencePayloadSha256: receipt.signature.payloadSha256,
      evidenceSignerKeySha256: receipt.signature.publicKeySha256,
      evidenceVerifierIdentity: receipt.verifierIdentity
    };
    if (!SUPPORTED_RELEASE_PLATFORMS.includes(cell.platform)
        || !Number.isInteger(cell.nodeMajor)) {
      throw new SingularityFlowError('Verification receipt has an unsupported platform or Node version.', {
        code: 'VERIFICATION_RECEIPT_INVALID', details: { platform: cell.platform, nodeVersion: cell.nodeVersion }
      });
    }
    const key = matrixKey(cell);
    if (byCell.has(key)) {
      throw new SingularityFlowError(`Verification receipt matrix repeats ${key}.`, {
        code: 'VERIFICATION_RECEIPT_INVALID'
      });
    }
    byCell.set(key, cell);
  }
  const platformMatrix = [...byCell.values()].sort((left, right) => (
    matrixKey(left).localeCompare(matrixKey(right))
  ));
  const unsigned = {
    schemaVersion: 3, // schema-transient: externally signed release receipt
    generatedAt,
    commit: first.commit,
    tree: first.tree,
    cleanCheckout: true,
    npmCi: 'passed',
    npmRunCheck: {
      passed: true,
      checks: Math.min(...verified.map((receipt) => receipt.npmRunCheck.checks))
    },
    npmTest: {
      passed: Math.min(...verified.map((receipt) => receipt.npmTest.passed)),
      failed: 0
    },
    platforms: [...new Set(platformMatrix.map((cell) => cell.platform))].sort(),
    nodeVersions: [...new Set(platformMatrix.map((cell) => cell.nodeVersion))].sort(),
    platformMatrix,
    artifactEvidence: {
      payloadSha256: artifactEvidence.signature.payloadSha256,
      signerKeySha256: artifactEvidence.signature.publicKeySha256,
      verifierIdentity: artifactEvidence.verifierIdentity
    },
    vscodeBuild: 'passed',
    packageSha256: first.packageSha256,
    vsixSha256: first.vsixSha256
  };
  return signVerificationReceipt(unsigned, privateKeyPem, verifierIdentity);
}
