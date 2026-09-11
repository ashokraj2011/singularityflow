#!/usr/bin/env node
/**
 * Promote the two exact artifacts a release consists of, and never rebuild either one.
 *
 * Singularity Flow ships as two files, not three: the npm tarball carries the CLI *and* the Copilot
 * plugin (`plugin/` is in `package.json` `files`), and the `.vsix` carries the extension with a full
 * CLI staged inside it. Both install identically on Windows, macOS and Linux — `install.sh` is a
 * build-from-source bootstrap for people working on the product, not the way anybody else gets it.
 *
 * `scripts/build-release-artifacts.mjs` is the only artifact producer. This promotion surface runs
 * the mandatory checks, verifies the independently signed artifact authority and six-cell release
 * authority, then byte-copies that exact pair into `dist/`.
 *
 * What it does not do is upload. The destination is an internal registry that differs per
 * organisation, and guessing at it in a tracked file would be worse than leaving the last step to
 * whoever knows the answer. It leaves `dist/` with both artefacts and their checksums, ready to go.
 *
 *   node scripts/release.mjs [--dry-run] [--skip-tests]
 *     --artifact-receipt <path> --artifact-key <trusted-builder-public-key.pem>
 *     --package <path> --vsix <path>
 *     --verification-receipt <path> --verification-key <trusted-public-key.pem>
 *
 * `--dry-run` verifies everything and writes nothing to `dist/`, so the whole promotion can be
 * rehearsed. A real promotion requires an independently signed clean-checkout receipt. `--skip-tests`
 * avoids rerunning locally only when that exact-commit receipt is already present and trusted.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseChannelManifest } from '../src/release-channel.mjs';
import {
  assertReleaseCheckoutClean, REQUIRED_RELEASE_PLATFORM_MATRIX, verifyVerificationReceipt
} from '../src/verification-receipt.mjs';
import {
  createVerifiedReleaseArtifactSnapshot, verifyReleaseArtifactReceipt
} from '../src/release-artifact-receipt.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';
import { readSecurePublicKey } from '../src/secure-private-key.mjs';
import {
  promoteReleaseDirectory, recoverReleaseDirectoryPromotion
} from '../src/release-directory-promotion.mjs';
import { readStableReleaseJson } from '../src/secure-release-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'apps', 'vscode');
const dist = path.join(root, 'dist');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipTests = argv.includes('--skip-tests');
function option(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}
const verificationReceiptPath = option('--verification-receipt');
const verificationKeyPath = option('--verification-key');
const artifactReceiptPath = option('--artifact-receipt');
const artifactKeyPath = option('--artifact-key');
const packagePath = option('--package');
const vsixPath = option('--vsix');
const releaseTestEnvironment = {
  ...process.env,
  SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1'
};

function step(message) { console.log(`\n• ${message}`); }

function must(command, args, { cwd = root, json = false, environment = process.env } = {}) {
  const launch = resolvePlatformProcess(command, args, { environment });
  const result = spawnSync(launch.executable, launch.arguments, {
    cwd,
    env: environment,
    encoding: 'utf8',
    stdio: json ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    ...launch.spawnOptions
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.`);
  }
  return result.stdout ?? '';
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main() {
  // A killed promotion can leave its durable journal/backup beside dist/. Reconcile only that
  // reserved namespace before the Git cleanliness gate; otherwise the very recovery metadata that
  // proves how to restore the prior release would make recovery unreachable.
  const recoveredPromotion = await recoverReleaseDirectoryPromotion(dist);
  if (recoveredPromotion.recovered) {
    console.warn(`Recovered interrupted dist/ promotion: ${recoveredPromotion.outcome}.`);
  }
  // A release has to be reproducible from a commit, and a dirty tree means the artefact contains
  // something no one can point at.
  const baseline = assertReleaseCheckoutClean(root, { label: 'Release start' });
  const { commit, tree } = baseline;
  if (!artifactReceiptPath || !artifactKeyPath || !packagePath || !vsixPath) {
    throw new Error(
      'Release requires --artifact-receipt <path> --artifact-key <trusted-builder-public.pem> '
      + '--package <path> and --vsix <path>. Build once with npm run release:artifacts; promotion never repackages.'
    );
  }
  const artifactReceipt = (await readStableReleaseJson(path.resolve(root, artifactReceiptPath), {
    label: 'Release artifact receipt', maxBytes: 1024 * 1024
  })).value;
  const trustedArtifactKey = (await readSecurePublicKey(path.resolve(root, artifactKeyPath), {
    repository: root, label: 'Trusted artifact-builder public key'
  })).bytes;
  const sourcePackagePath = path.resolve(root, packagePath);
  const sourceVsixPath = path.resolve(root, vsixPath);
  const artifactSnapshot = await createVerifiedReleaseArtifactSnapshot(artifactReceipt, {
    trustedPublicKeyPem: trustedArtifactKey,
    expectedCommit: commit,
    expectedTree: tree,
    packagePath: sourcePackagePath,
    vsixPath: sourceVsixPath
  });
  try {
  const exactArtifacts = artifactSnapshot;
  if (!verificationReceiptPath || !verificationKeyPath) {
    throw new Error('Release promotion and dry-run require --verification-receipt <path> and --verification-key <trusted-public-key.pem>. Generate the receipt with npm run verification:receipt -- --signing-key <ed25519-private.pem>.');
  }
  const verificationReceipt = (await readStableReleaseJson(path.resolve(root, verificationReceiptPath), {
    label: 'Verification matrix receipt', maxBytes: 16 * 1024 * 1024
  })).value;
  const trustedVerificationKey = (await readSecurePublicKey(path.resolve(root, verificationKeyPath), {
    repository: root, label: 'Trusted release-reviewer public key'
  })).bytes;
  verifyVerificationReceipt(verificationReceipt, {
    trustedPublicKeyPem: trustedVerificationKey,
    expectedCommit: commit,
    expectedTree: tree,
    artifactReceipt,
    trustedArtifactPublicKeyPem: trustedArtifactKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX,
    requireSgosEndToEnd: true
  });

  // `npm run check` already asserts one version across the root package, the plugin manifest, the
  // extension, both package-lock entries and the marketplace manifest — so there is no separate
  // parity check to run here, and a mismatch fails before anything is built.
  step('Checking governance and the version across every manifest');
  must('npm', ['run', 'check']);

  // Latency is a release property, not an optional developer observation. It stays in the local
  // release path because the benchmark needs the accepted baseline runtime/topology. It validates
  // absolute budgets everywhere and adds the relative 20-percent gate when it runs on
  // the exact runtime/topology of the accepted baseline.
  step('Enforcing developer-experience latency budgets');
  must('npm', ['run', 'benchmark:dx:enforce']);

  // Every explicit CommonJS entry is a separate parse/evaluation closure on first use. A new lazy
  // entry or accidental import can therefore regress both package size and interactive memory even
  // when activation remains fast. Keep the reviewed byte and source-module ceilings in the release
  // path, including releases that reuse an exact signed test receipt.
  step('Enforcing VS Code bundle and module-closure budgets');
  must('npm', ['run', 'vscode:bundle-budget']);

  if (skipTests) console.warn('  Local tests skipped; the exact-commit signed verification receipt remains the release authority.');
  else {
    step('Running the test suite');
    must('npm', ['test'], { environment: releaseTestEnvironment });
    step('Proving model-independent operation and lifecycle paths');
    must('npm', ['run', 'test:no-model']);
    step('Proving manual authorship and import paths');
    must('npm', ['run', 'test:manual-authorship']);
    step('Consuming the exact package and VSIX through the complete POC release gate');
    must('npm', [
      'run', 'poc:release-gate', '--',
      '--artifact-package', exactArtifacts.packagePath,
      '--artifact-vsix', exactArtifacts.vsixPath
    ], { environment: releaseTestEnvironment });
  }

  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const extensionManifest = JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8'));
  const { version } = manifest;
  const tarball = exactArtifacts.packagePath;
  const vsix = exactArtifacts.vsixPath;
  const expectedPackageName = `${manifest.name}-${version}.tgz`;
  const expectedVsixName = `${extensionManifest.name}-${extensionManifest.version}.vsix`;
  if (path.basename(tarball) !== expectedPackageName || path.basename(vsix) !== expectedVsixName) {
    throw new Error(
      `Signed artifacts do not match release version ${version}; expected ${expectedPackageName} and ${expectedVsixName}.`
    );
  }
  step(`Verifying the immutable artifact pair for ${version}`);
  const reverifiedArtifacts = await verifyReleaseArtifactReceipt(artifactReceipt, {
    trustedPublicKeyPem: trustedArtifactKey,
    expectedCommit: commit,
    expectedTree: tree,
    packagePath: tarball,
    vsixPath: vsix
  });
  assertReleaseCheckoutClean(root, {
    expectedCommit: commit, expectedTree: tree, label: 'Release artifact-consumption check'
  });
  verifyVerificationReceipt(verificationReceipt, {
    trustedPublicKeyPem: trustedVerificationKey,
    expectedCommit: commit,
    expectedTree: tree,
    expectedPackageSha256: reverifiedArtifacts.packageSha256,
    expectedVsixSha256: reverifiedArtifacts.vsixSha256,
    artifactReceipt,
    trustedArtifactPublicKeyPem: trustedArtifactKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX,
    requireSgosEndToEnd: true
  });

  if (dryRun) {
    step('Dry run: nothing written to dist/');
    console.log(`  verified package: ${sourcePackagePath}`);
    console.log(`  verified VSIX: ${sourceVsixPath}`);
    return;
  }

  step('Preparing an atomic dist/ candidate');
  await mkdir(path.dirname(dist), { recursive: true });
  const candidateDist = await mkdtemp(path.join(path.dirname(dist), '.dist-candidate-'));
  let candidatePublished = false;
  try {
  for (const artefact of [tarball, vsix]) {
    await copyFile(artefact, path.join(candidateDist, path.basename(artefact)));
  }
  // Close the verify/copy race by validating the destination bytes, not merely the earlier source
  // descriptors. A concurrently replaced input can never become a promoted artifact.
  await verifyReleaseArtifactReceipt(artifactReceipt, {
    trustedPublicKeyPem: trustedArtifactKey,
    expectedCommit: commit,
    expectedTree: tree,
    packagePath: path.join(candidateDist, path.basename(tarball)),
    vsixPath: path.join(candidateDist, path.basename(vsix))
  });

  const names = (await readdir(candidateDist)).sort();
  const sums = [];
  const artifacts = [];
  for (const name of names) {
    const digest = await sha256(path.join(candidateDist, name));
    sums.push(`${digest}  ${name}`);
    artifacts.push({
      name,
      kind: name.endsWith('.vsix') ? 'vscode-extension' : 'cli-and-copilot-plugin',
      sha256: digest
    });
  }
  await writeFile(path.join(candidateDist, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  await writeFile(path.join(candidateDist, 'RELEASE.json'), `${JSON.stringify({
    version,
    commit,
    node: `v${artifactReceipt.packagingProfile.nodeVersion}`,
    npm: artifactReceipt.packagingProfile.npmVersion,
    zlib: artifactReceipt.packagingProfile.zlibVersion,
    artifactReceiptSha256: artifactReceipt.signature.payloadSha256,
    artefacts: names
  }, null, 2)}\n`);
  await writeFile(path.join(candidateDist, 'RELEASE-CHANNEL.json'), `${JSON.stringify(releaseChannelManifest({
    version,
    commit,
    minNode: manifest.engines.node,
    minVSCode: extensionManifest.engines.vscode,
    artifacts,
    builtWithNode: `v${artifactReceipt.packagingProfile.nodeVersion}`
  }), null, 2)}\n`);
  await writeFile(path.join(candidateDist, 'ARTIFACT-RECEIPT.json'), `${JSON.stringify(artifactReceipt, null, 2)}\n`);
  await writeFile(path.join(candidateDist, 'VERIFICATION-RECEIPT.json'), `${JSON.stringify(verificationReceipt, null, 2)}\n`);
  await promoteReleaseDirectory(candidateDist, dist);
  candidatePublished = true;

  console.log([
    '',
    `Release ${version} promoted from ${commit.slice(0, 12)}:`,
    ...names.map((name) => `  dist/${name}`),
    '',
    'Upload both artefacts to the internal registry, then install them with:',
    `  npm install --global <registry>/${path.basename(tarball)}`,
    '  singularity-flow plugin install',
    `  code --install-extension <path>/${path.basename(vsix)}`,
    '',
    'Those commands are the same on Windows, macOS and Linux.',
    ''
  ].join('\n'));
  } finally {
    if (!candidatePublished) await rm(candidateDist, { recursive: true, force: true });
  }
  } finally {
    await rm(artifactSnapshot.snapshotDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error.message}`);
  process.exitCode = 1;
});
