#!/usr/bin/env node
/** Run the clean-checkout release checks and sign exactly the evidence observed on this host. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { signVerificationReceipt } from '../src/verification-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}
const signingKey = option('--signing-key');
const defaultOutput = spawnSync(
  'git', ['rev-parse', '--path-format=absolute', '--git-path', 'singularity-flow/verification-receipt.json'],
  { cwd: root, encoding: 'utf8' }
).stdout.trim();
const output = path.resolve(root, option('--out') ?? defaultOutput);
const identity = option('--identity')
  ?? spawnSync('git', ['config', 'user.email'], { cwd: root, encoding: 'utf8' }).stdout.trim();

function run(command, commandArgs) {
  console.log(`\n• ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
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
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (dirty) throw new Error(`Verification requires a clean checkout:\n${dirty}`);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  run('npm', ['ci']);
  const checkOutput = run('npm', ['run', 'check']);
  const testOutput = run('npm', ['test']);
  run('npm', ['run', 'vscode:package']);
  const packed = JSON.parse(run('npm', ['pack', '--json']));
  const packageFile = path.join(root, packed[0].filename);
  const extensionManifest = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
  const vsixFile = path.join(
    root, 'apps', 'vscode', `${extensionManifest.name}-${extensionManifest.version}.vsix`
  );
  if (!existsSync(vsixFile)) throw new Error(`VSIX packaging did not produce ${vsixFile}.`);
  const receipt = signVerificationReceipt({
    schemaVersion: 2, // schema-transient: externally signed release receipt, not a migration-registry record
    generatedAt: new Date().toISOString(),
    commit,
    tree,
    cleanCheckout: true,
    npmCi: 'passed',
    npmRunCheck: { passed: true, checks: count(checkOutput, /(\d+) checks passed/g) },
    npmTest: {
      passed: count(testOutput, /(?:ℹ|#) pass (\d+)/g),
      failed: count(testOutput, /(?:ℹ|#) fail (\d+)/g) ?? 0
    },
    platforms: [process.platform],
    nodeVersions: [process.versions.node],
    vscodeBuild: 'passed',
    packageSha256: await digest(packageFile),
    vsixSha256: await digest(vsixFile)
  }, await readFile(signingKey), identity);
  if (!Number.isInteger(receipt.npmTest.passed) || receipt.npmTest.passed < 1) {
    throw new Error('Could not extract the passing test count; no receipt was written.');
  }
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rm(packageFile, { force: true });
  console.log(`\nSigned verification receipt: ${output}`);
  console.log(`Verified VSIX retained for exact promotion: ${vsixFile}`);
}

main().catch((error) => { console.error(`\nVerification failed: ${error.message}`); process.exitCode = 1; });
