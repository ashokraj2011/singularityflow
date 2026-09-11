#!/usr/bin/env node
/**
 * Run clean-checkout checks and sign exactly the evidence observed on this host.
 *
 * Usage:
 *   node scripts/verification-receipt.mjs --signing-key <private.pem>
 *     --platform-evidence <reviewed-evidence.json>
 *     --artifact-receipt <receipt.json> --artifact-key <builder-public.pem>
 *     --package <release.tgz> --vsix <release.vsix>
 *     [--identity <reviewer>] [--out <receipt.json>]
 *
 * Physical host evidence is collected outside this script. Requiring it as an explicit input keeps
 * a source-level or simulated test from being mislabeled as real VS Code, installer, network, MCP,
 * or Windows execution evidence.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseCheckoutClean, parseReleaseTestSummary, signVerificationReceipt,
  validateReleasePlatformEvidence
} from '../src/verification-receipt.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';
import {
  createVerifiedReleaseArtifactSnapshot, verifyReleaseArtifactReceipt
} from '../src/release-artifact-receipt.mjs';
import { validateWelBenchmarkEvidence } from '../src/wel-benchmark-evidence.mjs';
import { readSecurePrivateKey, readSecurePublicKey } from '../src/secure-private-key.mjs';
import {
  readStableReleaseJson, writeReleaseJsonNoClobber
} from '../src/secure-release-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}
const signingKey = option('--signing-key');
const platformEvidenceOption = option('--platform-evidence');
const artifactReceiptOption = option('--artifact-receipt');
const artifactKeyOption = option('--artifact-key');
const packageOption = option('--package');
const vsixOption = option('--vsix');
const defaultOutput = spawnSync(
  'git', ['rev-parse', '--path-format=absolute', '--git-path', 'singularity-flow/verification-receipt.json'],
  { cwd: root, encoding: 'utf8' }
).stdout.trim();
const output = path.resolve(root, option('--out') ?? defaultOutput);
const identity = option('--identity')
  ?? spawnSync('git', ['config', 'user.email'], { cwd: root, encoding: 'utf8' }).stdout.trim();

function run(command, commandArgs, { releaseTests = false, environment = {} } = {}) {
  console.log(`\n• ${command} ${commandArgs.join(' ')}`);
  const effectiveEnvironment = releaseTests ? {
    ...process.env,
    ...environment,
    SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1'
  } : { ...process.env, ...environment };
  const launch = resolvePlatformProcess(command, commandArgs, { environment: effectiveEnvironment });
  const result = spawnSync(launch.executable, launch.arguments, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: effectiveEnvironment,
    ...launch.spawnOptions
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed with status ${result.status}.`);
  return result.stdout ?? '';
}

async function runReleaseGateAndCollectWelBenchmark({ packagePath, vsixPath }) {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-release-evidence-'));
  const benchmarkPath = path.join(evidenceDirectory, 'wel-benchmark.json');
  try {
    run('npm', [
      'run', 'poc:release-gate', '--',
      '--artifact-package', packagePath,
      '--artifact-vsix', vsixPath
    ], {
      releaseTests: true,
      environment: { SINGULARITY_FLOW_WEL_BENCHMARK_OUT: benchmarkPath }
    });
    let report;
    try {
      report = (await readStableReleaseJson(benchmarkPath, {
        label: 'WEL benchmark evidence', maxBytes: 8 * 1024 * 1024
      })).value;
    } catch (error) {
      throw new Error(`POC release gate did not retain valid WEL benchmark evidence: ${error.message}`);
    }
    return validateWelBenchmarkEvidence(report, {
      platform: process.platform,
      nodeMajor: Number(process.versions.node.split('.')[0]),
      requireObserved: true
    });
  } finally {
    await rm(evidenceDirectory, { recursive: true, force: true });
  }
}

function count(outputText, expression) {
  const match = [...outputText.matchAll(expression)].at(-1);
  return match ? Number(match[1]) : null;
}

async function main() {
  if (!signingKey) throw new Error('Provide an Ed25519 private key with --signing-key <path>.');
  if (!artifactReceiptOption || !artifactKeyOption || !packageOption || !vsixOption) {
    throw new Error(
      'Provide the immutable build output with --artifact-receipt <path> --artifact-key '
      + '<trusted-builder-public.pem> --package <path> --vsix <path>. Verification cells never rebuild artifacts.'
    );
  }
  if (!platformEvidenceOption) {
    throw new Error(
      'Provide reviewed physical evidence with --platform-evidence <json-path>. '
      + 'The receipt generator does not fabricate installed-host, installer, network-isolation, or authenticated-MCP evidence.'
    );
  }
  const platformEvidencePath = path.resolve(root, platformEvidenceOption);
  const platformEvidenceInput = (await readStableReleaseJson(platformEvidencePath, {
    label: 'Platform evidence', maxBytes: 1024 * 1024
  })).value;
  const baseline = assertReleaseCheckoutClean(root, { label: 'Verification start' });
  const { commit, tree } = baseline;
  const signingAuthority = await readSecurePrivateKey(signingKey, {
    repository: root, label: 'Verification signing key'
  });
  if (output === signingAuthority.path) {
    throw new Error('Verification receipt output must not overwrite its signing key.');
  }
  const artifactReceiptPath = path.resolve(root, artifactReceiptOption);
  const artifactKeyPath = path.resolve(root, artifactKeyOption);
  const sourcePackagePath = path.resolve(root, packageOption);
  const sourceVsixPath = path.resolve(root, vsixOption);
  const artifactReceipt = (await readStableReleaseJson(artifactReceiptPath, {
    label: 'Release artifact receipt', maxBytes: 1024 * 1024
  })).value;
  const artifactKey = (await readSecurePublicKey(artifactKeyPath, {
    repository: root, label: 'Trusted artifact-builder public key'
  })).bytes;
  const artifactSnapshot = await createVerifiedReleaseArtifactSnapshot(artifactReceipt, {
    trustedPublicKeyPem: artifactKey,
    expectedCommit: commit,
    expectedTree: tree,
    packagePath: sourcePackagePath,
    vsixPath: sourceVsixPath
  });
  try {
  const packagePath = artifactSnapshot.packagePath;
  const vsixPath = artifactSnapshot.vsixPath;
  const artifactAuthority = artifactSnapshot;
  validateReleasePlatformEvidence(platformEvidenceInput, {
    platform: process.platform,
    nodeVersion: process.versions.node,
    commit,
    tree,
    packageSha256: artifactAuthority.packageSha256,
    vsixSha256: artifactAuthority.vsixSha256,
    reviewerIdentity: identity,
    requireSgosEndToEnd: true
  });
  run('npm', ['ci']);
  const checkOutput = run('npm', ['run', 'check']);
  const testOutput = run('npm', ['test'], { releaseTests: true });
  const npmTest = parseReleaseTestSummary(testOutput);
  const welBenchmark = await runReleaseGateAndCollectWelBenchmark({ packagePath, vsixPath });
  assertReleaseCheckoutClean(root, {
    expectedCommit: commit, expectedTree: tree, label: 'Verification post-test check'
  });
  const finalArtifactAuthority = await verifyReleaseArtifactReceipt(artifactReceipt, {
    trustedPublicKeyPem: artifactKey,
    expectedCommit: commit,
    expectedTree: tree,
    packagePath,
    vsixPath
  });
  // A mutation of the handoff files cannot affect executed bytes because the smokes used the
  // private snapshot. Still refuse it so operators do not retain a changed artifact pair.
  await verifyReleaseArtifactReceipt(artifactReceipt, {
    trustedPublicKeyPem: artifactKey,
    expectedCommit: commit,
    expectedTree: tree,
    packagePath: sourcePackagePath,
    vsixPath: sourceVsixPath
  });
  const checkCount = count(checkOutput, /(\d+) checks passed/g);
  if (!Number.isInteger(checkCount) || checkCount < 1) {
    throw new Error('Could not extract the passing governance-check count; no receipt was written.');
  }
  const platformEvidence = validateReleasePlatformEvidence(platformEvidenceInput, {
    platform: process.platform,
    nodeVersion: process.versions.node,
    commit,
    tree,
    packageSha256: finalArtifactAuthority.packageSha256,
    vsixSha256: finalArtifactAuthority.vsixSha256,
    reviewerIdentity: identity,
    requireSgosEndToEnd: true
  });
  const receipt = signVerificationReceipt({
    schemaVersion: 6, // schema-transient: externally signed release receipt, not a migration-registry record
    generatedAt: new Date().toISOString(),
    commit,
    tree,
    cleanCheckout: true,
    npmCi: 'passed',
    npmRunCheck: { passed: true, checks: checkCount },
    npmTest,
    pocReleaseGate: 'passed',
    platforms: [process.platform],
    nodeVersions: [process.versions.node],
    artifactConsumption: 'passed',
    artifactAuthority: {
      payloadSha256: finalArtifactAuthority.payloadSha256,
      signerKeySha256: finalArtifactAuthority.signerKeySha256,
      builderIdentity: finalArtifactAuthority.builderIdentity
    },
    packageSha256: finalArtifactAuthority.packageSha256,
    vsixSha256: finalArtifactAuthority.vsixSha256,
    welBenchmark: welBenchmark.evidence,
    welBenchmarkSha256: welBenchmark.evidenceSha256,
    platformEvidence: platformEvidence.evidence,
    platformEvidenceSha256: platformEvidence.evidenceSha256
  }, signingAuthority.bytes, identity);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeReleaseJsonNoClobber(output, receipt);
  console.log(`\nSigned verification receipt: ${output}`);
  console.log(`Verified immutable artifact receipt: ${artifactReceiptPath}`);
  } finally {
    await rm(artifactSnapshot.snapshotDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(`\nVerification failed: ${error.message}`); process.exitCode = 1; });
