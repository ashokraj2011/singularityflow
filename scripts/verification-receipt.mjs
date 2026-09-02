#!/usr/bin/env node
/**
 * Run clean-checkout checks and sign exactly the evidence observed on this host.
 *
 * Usage:
 *   node scripts/verification-receipt.mjs --signing-key <private.pem>
 *     --platform-evidence <reviewed-evidence.json> [--identity <reviewer>] [--out <receipt.json>]
 *
 * Physical host evidence is collected outside this script. Requiring it as an explicit input keeps
 * a source-level or simulated test from being mislabeled as real VS Code, installer, network, MCP,
 * or Windows execution evidence.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseCheckoutClean, parseReleaseTestSummary, signVerificationReceipt,
  validateReleasePlatformEvidence
} from '../src/verification-receipt.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}
const signingKey = option('--signing-key');
const platformEvidenceOption = option('--platform-evidence');
const defaultOutput = spawnSync(
  'git', ['rev-parse', '--path-format=absolute', '--git-path', 'singularity-flow/verification-receipt.json'],
  { cwd: root, encoding: 'utf8' }
).stdout.trim();
const output = path.resolve(root, option('--out') ?? defaultOutput);
const identity = option('--identity')
  ?? spawnSync('git', ['config', 'user.email'], { cwd: root, encoding: 'utf8' }).stdout.trim();

function run(command, commandArgs, { releaseTests = false } = {}) {
  console.log(`\n• ${command} ${commandArgs.join(' ')}`);
  const environment = releaseTests ? {
    ...process.env,
    SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1'
  } : process.env;
  const launch = resolvePlatformProcess(command, commandArgs, { environment });
  const result = spawnSync(launch.executable, launch.arguments, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: environment,
    ...launch.spawnOptions
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed with status ${result.status}.`);
  return result.stdout ?? '';
}

function digest(file) { return readFile(file).then((bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`); }
function count(outputText, expression) {
  const match = [...outputText.matchAll(expression)].at(-1);
  return match ? Number(match[1]) : null;
}

async function main() {
  if (!signingKey || !existsSync(signingKey)) throw new Error('Provide an Ed25519 private key with --signing-key <path>.');
  if (!platformEvidenceOption) {
    throw new Error(
      'Provide reviewed physical evidence with --platform-evidence <json-path>. '
      + 'The receipt generator does not fabricate installed-host, installer, network-isolation, or authenticated-MCP evidence.'
    );
  }
  const platformEvidencePath = path.resolve(root, platformEvidenceOption);
  if (!existsSync(platformEvidencePath)) throw new Error(`Platform evidence does not exist: ${platformEvidencePath}`);
  let platformEvidenceInput;
  try {
    platformEvidenceInput = JSON.parse(await readFile(platformEvidencePath, 'utf8'));
  } catch (error) {
    throw new Error(`Platform evidence is not valid JSON: ${error.message}`);
  }
  const baseline = assertReleaseCheckoutClean(root, { label: 'Verification start' });
  const { commit, tree } = baseline;
  validateReleasePlatformEvidence(platformEvidenceInput, {
    platform: process.platform,
    nodeVersion: process.versions.node,
    commit,
    tree,
    reviewerIdentity: identity
  });
  run('npm', ['ci']);
  const checkOutput = run('npm', ['run', 'check']);
  const testOutput = run('npm', ['test'], { releaseTests: true });
  const npmTest = parseReleaseTestSummary(testOutput);
  run('npm', ['run', 'poc:release-gate'], { releaseTests: true });
  run('npm', ['run', 'vscode:package']);
  assertReleaseCheckoutClean(root, {
    expectedCommit: commit, expectedTree: tree, label: 'Verification pre-pack check'
  });
  const packed = JSON.parse(run('npm', ['pack', '--json']));
  const packageFile = path.join(root, packed[0].filename);
  const extensionManifest = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
  const vsixFile = path.join(
    root, 'apps', 'vscode', `${extensionManifest.name}-${extensionManifest.version}.vsix`
  );
  if (!existsSync(vsixFile)) throw new Error(`VSIX packaging did not produce ${vsixFile}.`);
  assertReleaseCheckoutClean(root, {
    expectedCommit: commit, expectedTree: tree, label: 'Verification packaged-artifact check'
  });
  const checkCount = count(checkOutput, /(\d+) checks passed/g);
  if (!Number.isInteger(checkCount) || checkCount < 1) {
    throw new Error('Could not extract the passing governance-check count; no receipt was written.');
  }
  const packageSha256 = await digest(packageFile);
  const vsixSha256 = await digest(vsixFile);
  const platformEvidence = validateReleasePlatformEvidence(platformEvidenceInput, {
    platform: process.platform,
    nodeVersion: process.versions.node,
    commit,
    tree,
    packageSha256,
    vsixSha256,
    reviewerIdentity: identity
  });
  const receipt = signVerificationReceipt({
    schemaVersion: 4, // schema-transient: externally signed release receipt, not a migration-registry record
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
    vscodeBuild: 'passed',
    packageSha256,
    vsixSha256,
    platformEvidence: platformEvidence.evidence,
    platformEvidenceSha256: platformEvidence.evidenceSha256
  }, await readFile(signingKey), identity);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rm(packageFile, { force: true });
  console.log(`\nSigned verification receipt: ${output}`);
  console.log(`Verified VSIX retained for exact promotion: ${vsixFile}`);
}

main().catch((error) => { console.error(`\nVerification failed: ${error.message}`); process.exitCode = 1; });
