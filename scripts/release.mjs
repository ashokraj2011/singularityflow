#!/usr/bin/env node
/**
 * Build the two artefacts a release consists of, and nothing else.
 *
 * Singularity Flow ships as two files, not three: the npm tarball carries the CLI *and* the Copilot
 * plugin (`plugin/` is in `package.json` `files`), and the `.vsix` carries the extension with a full
 * CLI staged inside it. Both install identically on Windows, macOS and Linux — `install.sh` is a
 * build-from-source bootstrap for people working on the product, not the way anybody else gets it.
 *
 * This is the deliberate local release surface. It runs the mandatory checks and produces
 * checksums for both packaged artifacts without requiring hosted Git automation. A human still
 * owns registry publication and any organisation-specific signing or provenance step.
 *
 * What it does not do is upload. The destination is an internal registry that differs per
 * organisation, and guessing at it in a tracked file would be worse than leaving the last step to
 * whoever knows the answer. It leaves `dist/` with both artefacts and their checksums, ready to go.
 *
 *   node scripts/release.mjs [--dry-run] [--skip-tests]
 *     --verification-receipt <path> --verification-key <trusted-public-key.pem>
 *
 * `--dry-run` builds everything and writes nothing to `dist/`, so the whole pipeline can be
 * rehearsed. A real promotion requires an independently signed clean-checkout receipt. `--skip-tests`
 * avoids rerunning locally only when that exact-commit receipt is already present and trusted.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseChannelManifest } from '../src/release-channel.mjs';
import { verifyVerificationReceipt } from '../src/verification-receipt.mjs';

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

function step(message) { console.log(`\n• ${message}`); }

function must(command, args, { cwd = root, json = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: json ? ['inherit', 'pipe', 'inherit'] : 'inherit'
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
  // A release has to be reproducible from a commit, and a dirty tree means the artefact contains
  // something no one can point at.
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (dirty) {
    throw new Error(`The working tree is not clean, so this release would not be reproducible:\n${dirty}`);
  }
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  let verificationReceipt = null;
  let trustedVerificationKey = null;
  if (!dryRun) {
    if (!verificationReceiptPath || !verificationKeyPath) {
      throw new Error('Release promotion requires --verification-receipt <path> and --verification-key <trusted-public-key.pem>. Generate the receipt with npm run verification:receipt -- --signing-key <ed25519-private.pem>.');
    }
    verificationReceipt = JSON.parse(await readFile(path.resolve(root, verificationReceiptPath), 'utf8'));
    trustedVerificationKey = await readFile(path.resolve(root, verificationKeyPath));
    verifyVerificationReceipt(verificationReceipt, {
      trustedPublicKeyPem: trustedVerificationKey,
      expectedCommit: commit,
      expectedTree: tree
    });
  }

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

  if (skipTests) console.warn('  Local tests skipped; the exact-commit signed verification receipt remains the release authority.');
  else {
    step('Running the test suite');
    must('npm', ['test']);
    step('Proving model-independent operation and lifecycle paths');
    must('npm', ['run', 'test:no-model']);
    step('Proving manual authorship and import paths');
    must('npm', ['run', 'test:manual-authorship']);
  }

  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const extensionManifest = JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8'));
  const { version } = manifest;
  step(`Packing the CLI and Copilot plugin (${version})`);
  const packed = JSON.parse(must('npm', ['pack', '--json'], { json: true }));
  const tarball = path.join(root, packed[0].filename);
  if (!dryRun) {
    verifyVerificationReceipt(verificationReceipt, {
      trustedPublicKeyPem: trustedVerificationKey,
      expectedCommit: commit,
      expectedTree: tree,
      expectedPackageSha256: `sha256:${await sha256(tarball)}`
    });
  }

  const vsix = path.join(extension, `${extensionManifest.name}-${version}.vsix`);
  step(!dryRun && existsSync(vsix)
    ? 'Using the exact VSIX bound by the signed verification receipt'
    : 'Building the VS Code extension');
  // Through the staging script, never `vsce` directly: `vsce package` on its own produces a .vsix
  // with no engine inside it, which installs cleanly and then fails to do anything.
  if (dryRun || !existsSync(vsix)) must('node', [path.join(root, 'scripts', 'vscode-dev.mjs'), '--package']);
  if (!existsSync(vsix)) throw new Error(`The extension package was not produced at ${vsix}.`);
  if (!dryRun) {
    verifyVerificationReceipt(verificationReceipt, {
      trustedPublicKeyPem: trustedVerificationKey,
      expectedCommit: commit,
      expectedTree: tree,
      expectedPackageSha256: `sha256:${await sha256(tarball)}`,
      expectedVsixSha256: `sha256:${await sha256(vsix)}`
    });
  }

  if (dryRun) {
    step('Dry run: nothing written to dist/');
    console.log(`  ${path.relative(root, tarball)}`);
    console.log(`  ${path.relative(root, vsix)}`);
    await rm(tarball, { force: true });
    return;
  }

  step('Collecting dist/');
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  for (const artefact of [tarball, vsix]) {
    await copyFile(artefact, path.join(dist, path.basename(artefact)));
  }
  await rm(tarball, { force: true });

  const names = (await readdir(dist)).sort();
  const sums = [];
  const artifacts = [];
  for (const name of names) {
    const digest = await sha256(path.join(dist, name));
    sums.push(`${digest}  ${name}`);
    artifacts.push({
      name,
      kind: name.endsWith('.vsix') ? 'vscode-extension' : 'cli-and-copilot-plugin',
      sha256: digest
    });
  }
  await writeFile(path.join(dist, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  await writeFile(path.join(dist, 'RELEASE.json'), `${JSON.stringify({
    version, commit, node: process.version, builtOn: process.platform, artefacts: names
  }, null, 2)}\n`);
  await writeFile(path.join(dist, 'RELEASE-CHANNEL.json'), `${JSON.stringify(releaseChannelManifest({
    version,
    commit,
    minNode: manifest.engines.node,
    minVSCode: extensionManifest.engines.vscode,
    artifacts
  }), null, 2)}\n`);
  await writeFile(path.join(dist, 'VERIFICATION-RECEIPT.json'), `${JSON.stringify(verificationReceipt, null, 2)}\n`);

  console.log([
    '',
    `Release ${version} built from ${commit.slice(0, 12)}:`,
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
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error.message}`);
  process.exitCode = 1;
});
