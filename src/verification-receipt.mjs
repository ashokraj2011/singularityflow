/** Independently verifiable clean-checkout release evidence for installations without hosted CI. */
import {
  createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes
} from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';
import { MCP_SCAFFOLD_VERSIONS } from './mcp-host.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

const SUPPORTED_RELEASE_PLATFORMS = Object.freeze(['darwin', 'linux', 'win32']);
const SUPPORTED_RELEASE_NODE_MAJORS = Object.freeze([20, 22]);
const SINGLE_RECEIPT_VERSION = 4; // schema-transient: externally signed release receipt
const MATRIX_RECEIPT_VERSION = 5; // schema-transient: externally signed release receipt
const PLATFORM_EVIDENCE_VERSION = 1; // schema-transient: reviewed external evidence input
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const NODE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SAFE_MECHANISM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLAYWRIGHT_PACKAGE = '@playwright/mcp';

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return plainObject(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function validIdentity(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function passedEvidenceFailures(value, label, mechanismField = null, additionalKeys = []) {
  const keys = [
    'evidenceSha256', 'outcome', ...(mechanismField ? [mechanismField] : []), ...additionalKeys
  ];
  const failures = [];
  if (!hasExactKeys(value, keys)) failures.push(`${label} fields are invalid`);
  if (value?.outcome !== 'passed') failures.push(`${label} did not pass`);
  if (!SHA256.test(String(value?.evidenceSha256 ?? ''))) failures.push(`${label} evidenceSha256 is invalid`);
  if (mechanismField && !SAFE_MECHANISM.test(String(value?.[mechanismField] ?? ''))) {
    failures.push(`${label} ${mechanismField} must be a lower-kebab identifier`);
  }
  return failures;
}

function collectPlatformEvidenceFailures(value, expected = {}) {
  const failures = [];
  const topLevelKeys = [
    'checks', 'commit', 'nodeVersion', 'packageSha256', 'platform', 'reviewedAt',
    'reviewerIdentity', 'schemaVersion', 'tree', 'vsixSha256'
  ];
  if (!hasExactKeys(value, topLevelKeys)) failures.push('platform evidence fields are invalid');
  const evidenceVersion = value?.schemaVersion;
  if (evidenceVersion !== PLATFORM_EVIDENCE_VERSION) {
    failures.push(`platform evidence schemaVersion must be ${PLATFORM_EVIDENCE_VERSION}`);
  }
  if (!SUPPORTED_RELEASE_PLATFORMS.includes(value?.platform)) failures.push('platform evidence platform is unsupported');
  if (!NODE_VERSION.test(String(value?.nodeVersion ?? ''))) failures.push('platform evidence nodeVersion is invalid');
  else if (!SUPPORTED_RELEASE_NODE_MAJORS.includes(nodeMajor(value.nodeVersion))) {
    failures.push('platform evidence Node major is outside the supported release matrix');
  }
  if (!GIT_OBJECT_ID.test(String(value?.commit ?? ''))) failures.push('platform evidence commit is invalid');
  if (!GIT_OBJECT_ID.test(String(value?.tree ?? ''))) failures.push('platform evidence tree is invalid');
  if (!SHA256.test(String(value?.packageSha256 ?? ''))) failures.push('platform evidence packageSha256 is invalid');
  if (!SHA256.test(String(value?.vsixSha256 ?? ''))) failures.push('platform evidence vsixSha256 is invalid');
  if (!validIdentity(value?.reviewerIdentity)) failures.push('platform evidence reviewerIdentity is invalid');
  if (!validTimestamp(value?.reviewedAt)) failures.push('platform evidence reviewedAt is invalid');

  const expectedFields = [
    ['platform', 'platform'], ['nodeVersion', 'Node version'], ['commit', 'commit'], ['tree', 'tree'],
    ['packageSha256', 'package digest'], ['vsixSha256', 'VSIX digest'],
    ['reviewerIdentity', 'reviewer identity']
  ];
  for (const [field, label] of expectedFields) {
    if (expected[field] != null && value?.[field] !== expected[field]) {
      failures.push(`platform evidence ${label} does not match the verified release input`);
    }
  }

  const checks = value?.checks;
  const checkKeys = [
    'authenticatedPlaywrightSmoke', 'exactPackageLocalStart', 'installedVsixActivation',
    'stagedInstallerRecovery', 'windowsNpmNpxRoundTrip'
  ];
  if (!hasExactKeys(checks, checkKeys)) failures.push('platform evidence checks are invalid');
  failures.push(...passedEvidenceFailures(
    checks?.installedVsixActivation, 'installed VSIX activation'
  ));
  failures.push(...passedEvidenceFailures(
    checks?.stagedInstallerRecovery, 'staged installer recovery'
  ));
  failures.push(...passedEvidenceFailures(
    checks?.exactPackageLocalStart,
    'exact-package local start',
    'networkIsolationMechanism',
    ['packageClosureSha256', 'packageName', 'packageVersion']
  ));
  if (checks?.exactPackageLocalStart?.packageName !== PLAYWRIGHT_PACKAGE
      || checks?.exactPackageLocalStart?.packageVersion !== MCP_SCAFFOLD_VERSIONS.playwright
      || !SHA256.test(String(checks?.exactPackageLocalStart?.packageClosureSha256 ?? ''))) {
    failures.push(
      `exact-package local start must bind ${PLAYWRIGHT_PACKAGE}@${MCP_SCAFFOLD_VERSIONS.playwright} `
      + 'and its closure SHA-256'
    );
  }
  failures.push(...passedEvidenceFailures(
    checks?.authenticatedPlaywrightSmoke,
    'authenticated Playwright smoke',
    'authenticationMechanism',
    ['authenticationProfileSha256']
  ));
  if (!SHA256.test(String(checks?.authenticatedPlaywrightSmoke?.authenticationProfileSha256 ?? ''))) {
    failures.push('authenticated Playwright smoke authenticationProfileSha256 is invalid');
  }

  const windows = checks?.windowsNpmNpxRoundTrip;
  if (!hasExactKeys(windows, ['evidenceSha256', 'outcome', 'reasonCode'])) {
    failures.push('Windows npm/npx round-trip fields are invalid');
  } else if (value?.platform === 'win32') {
    if (windows.outcome !== 'passed' || !SHA256.test(String(windows.evidenceSha256 ?? ''))
        || windows.reasonCode !== null) {
      failures.push('Windows npm/npx round-trip must contain passed physical evidence on win32');
    }
  } else if (windows.outcome !== 'not-applicable' || windows.evidenceSha256 !== null
      || windows.reasonCode !== 'non-windows-platform') {
    failures.push('Windows npm/npx round-trip must be explicitly not-applicable off win32');
  }
  return failures;
}

/**
 * Validate the reviewed, digest-only description of physical release evidence. Raw transcripts,
 * commands, paths, credentials, and host details are intentionally not part of this contract.
 */
export function validateReleasePlatformEvidence(value, expected = {}) {
  const failures = collectPlatformEvidenceFailures(value, expected);
  if (failures.length) {
    throw new SingularityFlowError(
      `Release platform evidence is invalid: ${failures.join('; ')}.`,
      { code: 'VERIFICATION_PLATFORM_EVIDENCE_INVALID', details: { failures } }
    );
  }
  const evidence = structuredClone(value);
  return {
    evidence,
    evidenceSha256: `sha256:${sha256(canonicalJson(evidence))}`
  };
}

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

function gitValue(root, args, label) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'unknown Git failure').trim().slice(-8_192);
    throw new SingularityFlowError(`${label} could not inspect the release checkout${detail ? `: ${detail}` : '.'}`, {
      code: 'VERIFICATION_CHECKOUT_UNAVAILABLE'
    });
  }
  return result.stdout.trim();
}

/**
 * Prove that release inputs still name the same commit and tree and that neither the index nor the
 * working tree contains a tracked or untracked change. Build output covered by `.gitignore` remains
 * outside this source-integrity assertion; tracked files are never silently allowed.
 */
export function assertReleaseCheckoutClean(root, {
  expectedCommit = null,
  expectedTree = null,
  label = 'Release verification'
} = {}) {
  const status = gitValue(root, ['status', '--porcelain=v1', '--untracked-files=all'], label);
  const commit = gitValue(root, ['rev-parse', '--verify', 'HEAD'], label);
  const tree = gitValue(root, ['rev-parse', '--verify', 'HEAD^{tree}'], label);
  const failures = [];
  if (status) failures.push(`index or working tree changed:\n${status.slice(0, 16_384)}`);
  if (expectedCommit && commit !== expectedCommit) failures.push(`HEAD changed from ${expectedCommit} to ${commit}`);
  if (expectedTree && tree !== expectedTree) failures.push(`HEAD tree changed from ${expectedTree} to ${tree}`);
  if (failures.length) {
    throw new SingularityFlowError(`${label} requires the original clean checkout; ${failures.join('; ')}.`, {
      code: 'VERIFICATION_CHECKOUT_CHANGED',
      details: { failures, commit, tree }
    });
  }
  return { commit, tree };
}

/** Parse the final Node test summary as evidence, refusing absent or non-passing counters. */
export function parseReleaseTestSummary(output) {
  const text = String(output ?? '');
  const fields = ['passed', 'failed', 'cancelled', 'skipped', 'todo'];
  const labels = { passed: 'pass', failed: 'fail', cancelled: 'cancelled', skipped: 'skipped', todo: 'todo' };
  const counts = {};
  const missing = [];
  for (const field of fields) {
    const matches = [...text.matchAll(new RegExp(`(?:ℹ|#)\\s+${labels[field]}\\s+(\\d+)`, 'g'))];
    if (!matches.length) missing.push(field);
    else counts[field] = Number(matches.at(-1)[1]);
  }
  if (missing.length) {
    throw new SingularityFlowError(`Node test summary omitted required counter(s): ${missing.join(', ')}.`, {
      code: 'VERIFICATION_TEST_SUMMARY_INCOMPLETE', details: { missing }
    });
  }
  const forbidden = ['failed', 'cancelled', 'skipped', 'todo'].filter((field) => counts[field] !== 0);
  if (!Number.isInteger(counts.passed) || counts.passed < 1 || forbidden.length) {
    throw new SingularityFlowError('Node test summary is not a complete passing run without failed, skipped, cancelled, or todo tests.', {
      code: 'VERIFICATION_TEST_SUMMARY_FAILED', details: { counts }
    });
  }
  return counts;
}

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
  const artifactValid = artifact && typeof artifact === 'object' && !Array.isArray(artifact)
      && JSON.stringify(Object.keys(artifact).sort()) === JSON.stringify([
        'payloadSha256', 'signerKeySha256', 'verifierIdentity'
      ])
      && SHA256.test(String(artifact.payloadSha256 ?? ''))
      && SHA256.test(String(artifact.signerKeySha256 ?? ''))
      && validIdentity(artifact.verifierIdentity);
  if (!artifactValid) {
    failures.push('artifactEvidence is invalid');
  }
  for (const entry of receipt.platformMatrix) {
    const major = nodeMajor(entry?.nodeVersion);
    const exactFields = entry && typeof entry === 'object' && !Array.isArray(entry)
      && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify([
        'evidencePayloadSha256', 'evidenceSignerKeySha256', 'evidenceVerifierIdentity',
        'nodeMajor', 'nodeVersion', 'platform', 'platformEvidence', 'platformEvidenceSha256'
      ]);
    const valid = entry && typeof entry === 'object' && !Array.isArray(entry)
      && exactFields
      && SUPPORTED_RELEASE_PLATFORMS.includes(entry.platform)
      && Number.isInteger(entry.nodeMajor) && entry.nodeMajor === major
      && SUPPORTED_RELEASE_NODE_MAJORS.includes(entry.nodeMajor)
      && NODE_VERSION.test(String(entry.nodeVersion ?? ''))
      && SHA256.test(String(entry.evidencePayloadSha256 ?? ''))
      && SHA256.test(String(entry.evidenceSignerKeySha256 ?? ''))
      && SHA256.test(String(entry.platformEvidenceSha256 ?? ''))
      && validIdentity(entry.evidenceVerifierIdentity);
    if (!valid) {
      failures.push('platformMatrix contains an invalid evidence cell');
      continue;
    }
    const platformEvidenceFailures = collectPlatformEvidenceFailures(entry.platformEvidence, {
      platform: entry.platform,
      nodeVersion: entry.nodeVersion,
      commit: receipt.commit,
      tree: receipt.tree,
      packageSha256: receipt.packageSha256,
      vsixSha256: receipt.vsixSha256,
      reviewerIdentity: entry.evidenceVerifierIdentity
    });
    if (platformEvidenceFailures.length) {
      failures.push(...platformEvidenceFailures.map((failure) => (
        `platformMatrix ${entry.platform}/node-${entry.nodeMajor}: ${failure}`
      )));
    } else {
      const expectedDigest = `sha256:${sha256(canonicalJson(entry.platformEvidence))}`;
      if (entry.platformEvidenceSha256 !== expectedDigest) {
        failures.push(`platformMatrix ${entry.platform}/node-${entry.nodeMajor}: platform evidence digest is invalid`);
      }
    }
    const cell = {
      platform: entry.platform,
      nodeVersion: entry.nodeVersion,
      nodeMajor: entry.nodeMajor,
      evidencePayloadSha256: entry.evidencePayloadSha256,
      evidenceSignerKeySha256: entry.evidenceSignerKeySha256,
      evidenceVerifierIdentity: entry.evidenceVerifierIdentity,
      platformEvidence: structuredClone(entry.platformEvidence),
      platformEvidenceSha256: entry.platformEvidenceSha256
    };
    const key = matrixKey(cell);
    if (seen.has(key)) failures.push(`platformMatrix repeats ${key}`);
    seen.add(key);
    cells.push(cell);
  }
  if (artifactValid && !cells.some((cell) => (
    cell.evidencePayloadSha256 === artifact.payloadSha256
      && cell.evidenceSignerKeySha256 === artifact.signerKeySha256
      && cell.evidenceVerifierIdentity === artifact.verifierIdentity
  ))) {
    failures.push('artifactEvidence does not identify one platformMatrix cell');
  }
  const platforms = [...new Set(cells.map((cell) => cell.platform))].sort();
  const versions = [...new Set(cells.map((cell) => cell.nodeVersion))].sort();
  if (!Array.isArray(receipt.platforms)
      || JSON.stringify(platforms) !== JSON.stringify([...receipt.platforms].sort())) {
    failures.push('platforms do not equal the platformMatrix projection');
  }
  if (!Array.isArray(receipt.nodeVersions)
      || JSON.stringify(versions) !== JSON.stringify([...receipt.nodeVersions].sort())) {
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
  const isMatrix = receipt.platformMatrix != null;
  const receiptVersion = receipt.schemaVersion;
  if (receiptVersion !== (isMatrix ? MATRIX_RECEIPT_VERSION : SINGLE_RECEIPT_VERSION)) {
    failures.push(
      `schemaVersion must be ${isMatrix ? MATRIX_RECEIPT_VERSION : SINGLE_RECEIPT_VERSION} `
      + `for a ${isMatrix ? 'platform-matrix' : 'single-platform'} receipt`
    );
  }
  if (!GIT_OBJECT_ID.test(String(receipt.commit ?? ''))) failures.push('commit is invalid');
  if (!GIT_OBJECT_ID.test(String(receipt.tree ?? ''))) failures.push('tree is invalid');
  if (!validIdentity(receipt.verifierIdentity)) failures.push('verifierIdentity is invalid');
  if (receipt.cleanCheckout !== true) failures.push('cleanCheckout is not true');
  if (receipt.npmCi !== 'passed') failures.push('npmCi did not pass');
  if (receipt.npmRunCheck?.passed !== true
      || !Number.isInteger(receipt.npmRunCheck?.checks) || receipt.npmRunCheck.checks < 1) {
    failures.push('npmRunCheck did not record a positive passing check count');
  }
  if (receipt.npmTest?.failed !== 0
      || receipt.npmTest?.skipped !== 0
      || receipt.npmTest?.cancelled !== 0
      || receipt.npmTest?.todo !== 0
      || !Number.isInteger(receipt.npmTest?.passed) || receipt.npmTest.passed < 1) {
    failures.push('npmTest has no complete passing result without failed, skipped, cancelled, or todo tests');
  }
  if (receipt.pocReleaseGate !== 'passed') failures.push('pocReleaseGate did not pass');
  if (receipt.vscodeBuild !== 'passed') failures.push('vscodeBuild did not pass');
  if (!Array.isArray(receipt.platforms) || !receipt.platforms.length) failures.push('platforms are absent');
  if (!Array.isArray(receipt.nodeVersions) || !receipt.nodeVersions.length) failures.push('nodeVersions are absent');
  if (!isMatrix) {
    if (receipt.platforms?.length !== 1 || receipt.nodeVersions?.length !== 1) {
      failures.push('single-platform receipt must name exactly one platform and one Node version');
    } else {
      const evidenceFailures = collectPlatformEvidenceFailures(receipt.platformEvidence, {
        platform: receipt.platforms[0],
        nodeVersion: receipt.nodeVersions[0],
        commit: receipt.commit,
        tree: receipt.tree,
        packageSha256: receipt.packageSha256,
        vsixSha256: receipt.vsixSha256,
        reviewerIdentity: receipt.verifierIdentity
      });
      failures.push(...evidenceFailures);
      if (!evidenceFailures.length) {
        const expectedDigest = `sha256:${sha256(canonicalJson(receipt.platformEvidence))}`;
        if (receipt.platformEvidenceSha256 !== expectedDigest) {
          failures.push('platformEvidenceSha256 does not match platformEvidence');
        }
      }
    }
    if (receipt.artifactEvidence != null) failures.push('single-platform receipt must not contain artifactEvidence');
  } else if (receipt.platformEvidence != null || receipt.platformEvidenceSha256 != null) {
    failures.push('platform-matrix receipt must keep platform evidence inside each matrix cell');
  }
  failures.push(...validatePlatformMatrix(receipt, requiredPlatformMatrix).failures);
  if (!SHA256.test(String(receipt.packageSha256 ?? ''))) failures.push('packageSha256 is invalid');
  if (!SHA256.test(String(receipt.vsixSha256 ?? ''))) failures.push('vsixSha256 is invalid');
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
  if (!verified.some((receipt) => (
    receipt.signature.payloadSha256 === artifactEvidence?.signature?.payloadSha256
      && receipt.signature.publicKeySha256 === artifactEvidence?.signature?.publicKeySha256
      && receipt.verifierIdentity === artifactEvidence?.verifierIdentity
  ))) {
    throw new SingularityFlowError(
      'Selected artifact evidence must be one of the reviewed single-platform receipts.',
      { code: 'VERIFICATION_RECEIPT_REJECTED' }
    );
  }
  verifyVerificationReceipt(artifactEvidence, {
    trustedPublicKeyPem: embeddedPublicKey(artifactEvidence),
    expectedCommit: first.commit,
    expectedTree: first.tree,
    expectedPackageSha256: first.packageSha256,
    expectedVsixSha256: first.vsixSha256
  });
  const byCell = new Map();
  for (const receipt of verified) {
    const cell = {
      platform: receipt.platforms[0],
      nodeVersion: receipt.nodeVersions[0],
      nodeMajor: nodeMajor(receipt.nodeVersions[0]),
      evidencePayloadSha256: receipt.signature.payloadSha256,
      evidenceSignerKeySha256: receipt.signature.publicKeySha256,
      evidenceVerifierIdentity: receipt.verifierIdentity,
      platformEvidence: structuredClone(receipt.platformEvidence),
      platformEvidenceSha256: receipt.platformEvidenceSha256
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
    schemaVersion: MATRIX_RECEIPT_VERSION, // schema-transient: externally signed release receipt
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
      failed: 0,
      skipped: 0,
      cancelled: 0,
      todo: 0
    },
    pocReleaseGate: 'passed',
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
